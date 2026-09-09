(function () {
  'use strict';

  var storageApi = window.MeetingMinutesRecordings;
  var store = storageApi.createStore();
  var MAX_WINDOWS_BYTES = storageApi.MAX_WINDOWS_BYTES;
  var recordingsById = new Map();
  var storageReady = false;
  var activeSession = null;
  var isStarting = false;
  var startRequestId = 0;
  var startedAt = 0;
  var timerHandle = null;
  var wakeLock = null;
  var wakeLockRequestId = 0;
  var pendingSave = null;

  var startBtn = document.getElementById('startBtn');
  var stopBtn = document.getElementById('stopBtn');
  var retryBtn = document.getElementById('retryBtn');
  var audioInput = document.getElementById('audioInput');
  var statusDot = document.getElementById('statusDot');
  var statusText = document.getElementById('statusText');
  var timer = document.getElementById('timer');
  var message = document.getElementById('message');
  var recordingList = document.getElementById('recordingList');
  var recordCount = document.getElementById('recordCount');

  function pad(number) { return String(number).padStart(2, '0'); }

  function stamp(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '_' +
      pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
  }

  function extensionFor(mimeType) {
    if (mimeType.indexOf('mp4') >= 0 || mimeType.indexOf('m4a') >= 0) return 'm4a';
    if (mimeType.indexOf('webm') >= 0) return 'webm';
    if (mimeType.indexOf('wav') >= 0) return 'wav';
    if (mimeType.indexOf('mpeg') >= 0 || mimeType.indexOf('mp3') >= 0) return 'mp3';
    return 'audio';
  }

  function bestMimeType() {
    var types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    for (var index = 0; index < types.length; index += 1) {
      if (MediaRecorder.isTypeSupported(types[index])) return types[index];
    }
    return '';
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KiB';
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MiB';
  }

  function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs)) return 'לא זמין';
    var totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    return hours ? hours + ':' + pad(minutes) + ':' + pad(seconds) : pad(minutes) + ':' + pad(seconds);
  }

  function formatDate(timestamp) {
    try {
      return new Intl.DateTimeFormat('he-IL', {
        dateStyle: 'short',
        timeStyle: 'short'
      }).format(new Date(timestamp));
    } catch (error) {
      return new Date(timestamp).toLocaleString('he-IL');
    }
  }

  function setMessage(text, kind) {
    message.textContent = text;
    message.className = 'note message ' + (kind || 'info');
  }

  function setIdleControls() {
    startBtn.classList.remove('hidden');
    startBtn.disabled = !storageReady || isStarting || !!activeSession || !!pendingSave;
    stopBtn.classList.add('hidden');
    retryBtn.classList.add('hidden');
    audioInput.disabled = !storageReady || isStarting || !!activeSession || !!pendingSave;
    statusDot.className = 'dot ready';
    statusText.textContent = 'מוכן להקלטה';
  }

  function setStartingControls() {
    startBtn.classList.remove('hidden');
    startBtn.disabled = true;
    stopBtn.classList.add('hidden');
    retryBtn.classList.add('hidden');
    audioInput.disabled = true;
    statusDot.className = 'dot saving';
    statusText.textContent = 'פותח את המיקרופון';
    setMessage('ממתין לאישור המיקרופון…', 'info');
  }

  function setSavingControls() {
    startBtn.classList.add('hidden');
    stopBtn.classList.add('hidden');
    retryBtn.classList.add('hidden');
    audioInput.disabled = true;
    statusDot.className = 'dot saving';
    statusText.textContent = 'שומר באפליקציה';
  }

  function updateTimer() {
    var elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    timer.textContent = pad(Math.floor(elapsedSeconds / 60)) + ':' + pad(elapsedSeconds % 60);
  }

  function requestWakeLock(session) {
    if (!navigator.wakeLock) return;
    var requestId = ++wakeLockRequestId;
    navigator.wakeLock.request('screen').then(function (lock) {
      if (requestId !== wakeLockRequestId || activeSession !== session || session.failed) {
        lock.release().catch(function () {});
        return;
      }
      wakeLock = lock;
    }).catch(function () {});
  }

  function releaseWakeLock() {
    wakeLockRequestId += 1;
    if (wakeLock) wakeLock.release().catch(function () {});
    wakeLock = null;
  }

  function stopSessionTracks(session) {
    if (!session || !session.stream) return;
    session.stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (error) {}
    });
    session.stream = null;
  }

  function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
  }

  function makeMeta(label, value) {
    var item = document.createElement('div');
    item.className = 'recording-meta-item';
    var term = document.createElement('span');
    term.className = 'recording-meta-label';
    term.textContent = label;
    var description = document.createElement('strong');
    description.textContent = value;
    item.appendChild(term);
    item.appendChild(description);
    return item;
  }

  function shareRecording(record) {
    var file;
    try {
      file = new File([record.blob], record.fileName, {
        type: record.mimeType || record.blob.type || 'application/octet-stream',
        lastModified: record.createdAt
      });
    } catch (error) {
      setMessage('לא ניתן להכין את קובץ הקול לשיתוף. ההקלטה נשארת שמורה באפליקציה.', 'error');
      return;
    }

    if (typeof navigator.share !== 'function') {
      setMessage('המכשיר או הדפדפן אינם תומכים בשיתוף קובץ קול מתוך האפליקציה. ההקלטה נשארת שמורה.', 'error');
      return;
    }

    try {
      if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
        setMessage('המכשיר או הדפדפן אינם תומכים בשיתוף קובץ קול זה. ההקלטה נשארת שמורה.', 'error');
        return;
      }
    } catch (error) {
      setMessage('לא ניתן לבדוק אם קובץ הקול מתאים לשיתוף. ההקלטה נשארת שמורה.', 'error');
      return;
    }

    var sharePromise;
    try {
      sharePromise = navigator.share({ files: [file], title: 'סיכומי ישיבות' });
    } catch (error) {
      setMessage('גיליון השיתוף לא נפתח. ההקלטה נשארת שמורה באפליקציה.', 'error');
      return;
    }

    Promise.resolve(sharePromise).then(function () {
      setMessage('גיליון השיתוף נסגר. אין לאפליקציה אפשרות לוודא שהקובץ התקבל או נשמר ביעד; ההקלטה נשארת שמורה כאן.', 'info');
    }).catch(function (error) {
      if (error && error.name === 'AbortError') {
        setMessage('השיתוף לא בוצע או בוטל. ההקלטה נשארת שמורה באפליקציה.', 'info');
      } else {
        setMessage('השיתוף לא הושלם. ההקלטה נשארת שמורה באפליקציה ואפשר לנסות שוב.', 'error');
      }
    });
  }

  function handleShareClick(event) {
    var record = recordingsById.get(event.currentTarget.dataset.recordingId);
    if (!record) {
      setMessage('ההקלטה אינה זמינה כרגע. הרשימה תיטען מחדש.', 'error');
      refreshRecordings();
      return;
    }
    shareRecording(record);
  }

  function addOversizeShareControls(container, record) {
    var openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'large-share-button';
    openButton.textContent = 'המשך לשיתוף קובץ גדול';

    var confirmation = document.createElement('div');
    confirmation.className = 'large-share-confirm hidden';
    var warning = document.createElement('p');
    warning.textContent = 'אפליקציית Windows לא תוכל לעבד קובץ מעל 25 MiB. ההקלטה תישאר שמורה כאן גם לאחר השיתוף.';
    var confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'share-button';
    confirmButton.textContent = 'שתף עכשיו בכל זאת';
    var cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'cancel-delete';
    cancelButton.textContent = 'ביטול';
    confirmation.appendChild(warning);
    confirmation.appendChild(confirmButton);
    confirmation.appendChild(cancelButton);

    openButton.addEventListener('click', function () {
      openButton.classList.add('hidden');
      confirmation.classList.remove('hidden');
      confirmButton.focus();
    });
    cancelButton.addEventListener('click', function () {
      confirmation.classList.add('hidden');
      openButton.classList.remove('hidden');
      openButton.focus();
    });
    confirmButton.addEventListener('click', function () {
      confirmation.classList.add('hidden');
      openButton.classList.remove('hidden');
      shareRecording(record);
    });

    container.appendChild(openButton);
    container.appendChild(confirmation);
  }

  function addDeleteControls(container, record) {
    var openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'delete-button';
    openButton.textContent = 'מחיקה מהאפליקציה';

    var confirmation = document.createElement('div');
    confirmation.className = 'delete-confirm hidden';
    var warning = document.createElement('p');
    warning.textContent = 'למחוק את ההקלטה לצמיתות מהמכשיר? לא ניתן לשחזר אותה.';
    var confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'confirm-delete';
    confirmButton.textContent = 'כן, למחוק לצמיתות';
    var cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'cancel-delete';
    cancelButton.textContent = 'ביטול';
    confirmation.appendChild(warning);
    confirmation.appendChild(confirmButton);
    confirmation.appendChild(cancelButton);

    openButton.addEventListener('click', function () {
      openButton.classList.add('hidden');
      confirmation.classList.remove('hidden');
      confirmButton.focus();
    });
    cancelButton.addEventListener('click', function () {
      confirmation.classList.add('hidden');
      openButton.classList.remove('hidden');
      openButton.focus();
    });
    confirmButton.addEventListener('click', function () {
      confirmButton.disabled = true;
      cancelButton.disabled = true;
      store.deleteRecording(record.id).then(function () {
        recordingsById.delete(record.id);
        setMessage('ההקלטה נמחקה מהאפליקציה לאחר האישור.', 'info');
        return refreshRecordings();
      }).catch(function () {
        confirmButton.disabled = false;
        cancelButton.disabled = false;
        setMessage('המחיקה לא הושלמה. ההקלטה נשארה שמורה.', 'error');
      });
    });

    container.appendChild(openButton);
    container.appendChild(confirmation);
  }

  function renderRecordings(records) {
    recordingsById = new Map();
    recordingList.textContent = '';
    recordCount.textContent = records.length ? '(' + records.length + ')' : '';

    if (!records.length) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'עדיין אין הקלטות שמורות.';
      recordingList.appendChild(empty);
      return;
    }

    records.forEach(function (record) {
      recordingsById.set(record.id, record);
      var item = document.createElement('article');
      item.className = 'recording-item';
      var title = document.createElement('h3');
      title.textContent = 'הקלטה מ־' + formatDate(record.createdAt);
      var metadata = document.createElement('div');
      metadata.className = 'recording-meta';
      metadata.appendChild(makeMeta('תאריך', formatDate(record.createdAt)));
      metadata.appendChild(makeMeta('משך', formatDuration(record.durationMs)));
      metadata.appendChild(makeMeta('גודל', formatSize(record.size)));
      item.appendChild(title);
      item.appendChild(metadata);

      if (record.size > MAX_WINDOWS_BYTES) {
        var limit = document.createElement('p');
        limit.className = 'limit-warning';
        limit.textContent = 'הקובץ חורג ממגבלת 25 MiB של עיבוד Windows. הוא נשמר כאן וניתן לשיתוף ידני לאחר אישור נוסף.';
        item.appendChild(limit);
        addOversizeShareControls(item, record);
      } else {
        var shareButton = document.createElement('button');
        shareButton.type = 'button';
        shareButton.className = 'share-button';
        shareButton.dataset.recordingId = record.id;
        shareButton.textContent = 'שתף הקלטה זו';
        shareButton.addEventListener('click', handleShareClick);
        item.appendChild(shareButton);
      }
      addDeleteControls(item, record);
      recordingList.appendChild(item);
    });
  }

  function refreshRecordings() {
    return store.listRecordings().then(function (records) {
      renderRecordings(records);
      return records;
    });
  }

  function readAudioDuration(blob) {
    return new Promise(function (resolve) {
      var audio = document.createElement('audio');
      var objectUrl = URL.createObjectURL(blob);
      var finished = false;
      var timeout = setTimeout(function () { finish(null); }, 8000);

      function finish(value) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(objectUrl);
        resolve(value);
      }

      audio.preload = 'metadata';
      audio.onloadedmetadata = function () {
        var duration = audio.duration;
        finish(Number.isFinite(duration) && duration >= 0 ? duration * 1000 : null);
      };
      audio.onerror = function () { finish(null); };
      audio.src = objectUrl;
    });
  }

  function updateImportedDuration(recordId, blob) {
    readAudioDuration(blob).then(function (durationMs) {
      if (!Number.isFinite(durationMs)) return false;
      return store.updateDuration(recordId, durationMs);
    }).then(function (updated) {
      if (updated) return refreshRecordings();
    }).catch(function () {});
  }

  function persistPendingSave() {
    if (!pendingSave) return;
    setSavingControls();
    setMessage('שומר את קובץ הקול באחסון המתמשך של האפליקציה…', 'info');
    var itemToSave = pendingSave;

    store.saveRecording(itemToSave).then(function (savedRecord) {
      pendingSave = null;
      requestPersistentStorage();
      return refreshRecordings().then(function () {
        storageReady = true;
        setIdleControls();
        timer.textContent = '00:00';
        setMessage('ההקלטה נשמרה באפליקציה ותישאר ברשימה לאחר סגירה ופתיחה. כעת אפשר לשתף אותה מהפריט השמור.', 'success');
        if (itemToSave.source === 'file' && !Number.isFinite(itemToSave.durationMs)) {
          updateImportedDuration(savedRecord.id, itemToSave.blob);
        }
      });
    }).catch(function () {
      pendingSave = itemToSave;
      startBtn.classList.add('hidden');
      stopBtn.classList.add('hidden');
      retryBtn.classList.remove('hidden');
      audioInput.disabled = true;
      statusDot.className = 'dot error-dot';
      statusText.textContent = 'השמירה נכשלה';
      setMessage('השמירה המתמשכת נכשלה. הקובץ עדיין בזיכרון כל עוד הדף פתוח. אין לסגור את האפליקציה; לחץ „נסה שוב לשמור”.', 'error');
    });
  }

  function queueForSave(blob, details) {
    pendingSave = {
      id: storageApi.createRecordingId(),
      blob: blob,
      fileName: details.fileName,
      mimeType: details.mimeType || blob.type,
      createdAt: details.createdAt,
      durationMs: details.durationMs,
      source: details.source
    };
    persistPendingSave();
  }

  startBtn.addEventListener('click', function () {
    if (!storageReady || pendingSave || isStarting || activeSession) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setMessage('המכשיר או הדפדפן אינם תומכים בהקלטה מתוך האפליקציה.', 'error');
      return;
    }

    var requestId = ++startRequestId;
    isStarting = true;
    setStartingControls();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (mediaStream) {
      if (requestId !== startRequestId || !isStarting || activeSession) {
        mediaStream.getTracks().forEach(function (track) {
          try { track.stop(); } catch (error) {}
        });
        return;
      }
      isStarting = false;
      var session = {
        stream: mediaStream,
        recorder: null,
        chunks: [],
        mimeType: bestMimeType(),
        startedAt: 0,
        failed: false
      };
      activeSession = session;

      try {
        var options = session.mimeType ? { mimeType: session.mimeType } : undefined;
        session.recorder = new MediaRecorder(mediaStream, options);
      } catch (error) {
        session.failed = true;
        stopSessionTracks(session);
        activeSession = null;
        throw error;
      }

      session.recorder.addEventListener('dataavailable', function (event) {
        if (!session.failed && event.data && event.data.size) session.chunks.push(event.data);
      });
      session.recorder.addEventListener('stop', function () {
        var wasActive = activeSession === session;
        if (wasActive) activeSession = null;
        stopSessionTracks(session);
        if (wasActive) releaseWakeLock();

        if (session.failed) {
          session.chunks = [];
          if (wasActive) {
            setIdleControls();
            timer.textContent = '00:00';
            setMessage('ההקלטה נכשלה ולא נשמר קובץ חלקי. אפשר לנסות שוב.', 'error');
          }
          return;
        }

        var stoppedAt = Date.now();
        var mimeType = session.recorder.mimeType || session.mimeType || 'audio/webm';
        var blob = new Blob(session.chunks, { type: mimeType });
        session.chunks = [];
        if (!blob.size) {
          setIdleControls();
          setMessage('לא התקבל קול מההקלטה ולכן לא נשמר קובץ ריק. אפשר לנסות שוב.', 'error');
          return;
        }
        queueForSave(blob, {
          fileName: 'סיכומי-ישיבות_' + stamp(new Date(stoppedAt)) + '.' + extensionFor(mimeType),
          mimeType: mimeType,
          createdAt: session.startedAt,
          durationMs: Math.max(0, stoppedAt - session.startedAt),
          source: 'microphone'
        });
      });
      session.recorder.addEventListener('error', function () {
        session.failed = true;
        session.chunks = [];
        clearInterval(timerHandle);
        timerHandle = null;
        stopSessionTracks(session);
        if (activeSession === session) {
          releaseWakeLock();
          startBtn.classList.add('hidden');
          stopBtn.classList.add('hidden');
          retryBtn.classList.add('hidden');
          audioInput.disabled = true;
          statusDot.className = 'dot error-dot';
          statusText.textContent = 'ההקלטה נכשלה';
          setMessage('אירעה שגיאה בזמן ההקלטה. לא יישמר קובץ חלקי; ממתין לסיום הניקוי.', 'error');
        }
      });
      try {
        session.recorder.start(1000);
      } catch (error) {
        session.failed = true;
        session.chunks = [];
        stopSessionTracks(session);
        activeSession = null;
        throw error;
      }
      session.startedAt = Date.now();
      startedAt = session.startedAt;
      timerHandle = setInterval(updateTimer, 500);
      updateTimer();
      requestWakeLock(session);
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      retryBtn.classList.add('hidden');
      audioInput.disabled = true;
      statusDot.className = 'dot live';
      statusText.textContent = 'מקליט';
      setMessage('ההקלטה עדיין אינה שמורה. השאר את האפליקציה פתוחה עד שתסיים ותופיע הודעת שמירה.', 'info');
    }).catch(function (error) {
      if (requestId !== startRequestId) return;
      isStarting = false;
      clearInterval(timerHandle);
      timerHandle = null;
      if (activeSession) {
        activeSession.failed = true;
        activeSession.chunks = [];
        stopSessionTracks(activeSession);
        activeSession = null;
      }
      releaseWakeLock();
      setIdleControls();
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        setMessage('לא התקבלה הרשאת מיקרופון. אפשר לאשר הרשאה בהגדרות האתר ולנסות שוב.', 'error');
      } else {
        setMessage('לא ניתן לפתוח את המיקרופון במכשיר זה.', 'error');
      }
    });
  });

  stopBtn.addEventListener('click', function () {
    var session = activeSession;
    if (!session || !session.recorder || session.recorder.state === 'inactive') return;
    stopBtn.disabled = true;
    clearInterval(timerHandle);
    timerHandle = null;
    statusDot.className = 'dot saving';
    statusText.textContent = 'מסיים ושומר';
    setMessage('מסיים את ההקלטה ושומר אותה באפליקציה…', 'info');
    try {
      session.recorder.stop();
    } catch (error) {
      session.failed = true;
      session.chunks = [];
      stopSessionTracks(session);
      if (activeSession === session) activeSession = null;
      releaseWakeLock();
      setIdleControls();
      setMessage('לא ניתן היה לסיים את ההקלטה בצורה תקינה, ולכן לא נשמר קובץ חלקי.', 'error');
    } finally {
      stopBtn.disabled = false;
    }
  });

  retryBtn.addEventListener('click', persistPendingSave);

  audioInput.addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || !storageReady || pendingSave || isStarting || activeSession) return;
    if (!file.size) {
      setMessage('הקובץ שנבחר ריק ולכן לא נשמר.', 'error');
      return;
    }
    var audioExtension = /\.(m4a|mp3|wav|mp4|webm|weba|aac|ogg|oga|opus)$/i.test(file.name || '');
    if (!(file.type && file.type.indexOf('audio/') === 0) && !audioExtension) {
      setMessage('הקובץ שנבחר אינו מזוהה כקובץ שמע ולכן לא נשמר.', 'error');
      return;
    }
    queueForSave(file, {
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      createdAt: file.lastModified || Date.now(),
      durationMs: null,
      source: 'file'
    });
  });

  window.addEventListener('beforeunload', function (event) {
    if ((activeSession && activeSession.recorder && activeSession.recorder.state === 'recording') || pendingSave) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && activeSession && activeSession.recorder && activeSession.recorder.state === 'recording' && !wakeLock) {
      requestWakeLock(activeSession);
    }
  });

  function initialize() {
    startBtn.disabled = true;
    audioInput.disabled = true;
    refreshRecordings().then(function () {
      storageReady = true;
      setIdleControls();
      document.documentElement.dataset.appReady = 'true';
    }).catch(function () {
      storageReady = false;
      startBtn.disabled = true;
      audioInput.disabled = true;
      statusDot.className = 'dot error-dot';
      statusText.textContent = 'האחסון אינו זמין';
      setMessage('האחסון המתמשך אינו זמין, ולכן ההקלטה והייבוא חסומים כדי למנוע אובדן קובץ.', 'error');
      document.documentElement.dataset.appReady = 'storage-error';
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then(function (registration) { return registration.update(); })
        .catch(function () {});
    }
  }

  initialize();
})();
