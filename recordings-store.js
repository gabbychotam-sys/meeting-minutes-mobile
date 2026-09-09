(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MeetingMinutesRecordings = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_DB_NAME = 'meeting-minutes-mobile';
  var DB_VERSION = 1;
  var STORE_NAME = 'recordings';
  var MAX_WINDOWS_BYTES = 25 * 1024 * 1024;

  function createRecordingId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function isBlob(value) {
    return value && typeof value.size === 'number' && typeof value.slice === 'function';
  }

  function createStore(options) {
    options = options || {};
    var databaseName = options.databaseName || DEFAULT_DB_NAME;
    var indexedDb = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    var databasePromise = null;

    function openDatabase() {
      if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable'));
      if (databasePromise) return databasePromise;

      databasePromise = new Promise(function (resolve, reject) {
        var request = indexedDb.open(databaseName, DB_VERSION);
        request.onupgradeneeded = function () {
          var database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            var objectStore = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            objectStore.createIndex('createdAt', 'createdAt', { unique: false });
          }
        };
        request.onsuccess = function () {
          var database = request.result;
          database.onversionchange = function () {
            database.close();
            databasePromise = null;
          };
          resolve(database);
        };
        request.onerror = function () {
          databasePromise = null;
          reject(request.error || new Error('Unable to open IndexedDB'));
        };
        request.onblocked = function () {
          databasePromise = null;
          reject(new Error('IndexedDB upgrade is blocked'));
        };
      });
      return databasePromise;
    }

    function transact(mode, action) {
      return openDatabase().then(function (database) {
        return new Promise(function (resolve, reject) {
          var result;
          var transaction;
          try {
            transaction = database.transaction(STORE_NAME, mode);
            action(transaction.objectStore(STORE_NAME), function (value) { result = value; });
          } catch (error) {
            reject(error);
            return;
          }
          transaction.oncomplete = function () { resolve(result); };
          transaction.onerror = function () {
            reject(transaction.error || new Error('IndexedDB transaction failed'));
          };
          transaction.onabort = function () {
            reject(transaction.error || new Error('IndexedDB transaction was aborted'));
          };
        });
      });
    }

    function saveRecording(input) {
      if (!input || !isBlob(input.blob)) return Promise.reject(new TypeError('A Blob is required'));
      var createdAt = Number(input.createdAt);
      var durationMs = input.durationMs === null || input.durationMs === undefined
        ? null
        : Number(input.durationMs);
      var record = {
        id: String(input.id || createRecordingId()),
        blob: input.blob,
        fileName: String(input.fileName || ('meeting-' + Date.now() + '.audio')),
        mimeType: String(input.mimeType || input.blob.type || 'application/octet-stream'),
        size: input.blob.size,
        createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
        savedAt: Date.now(),
        durationMs: durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
        source: input.source === 'file' ? 'file' : 'microphone'
      };

      return transact('readwrite', function (objectStore, setResult) {
        var request = objectStore.put(record);
        request.onsuccess = function () { setResult(record); };
      });
    }

    function listRecordings() {
      return transact('readonly', function (objectStore, setResult) {
        var request = objectStore.getAll();
        request.onsuccess = function () {
          var records = request.result || [];
          records.sort(function (a, b) { return b.createdAt - a.createdAt; });
          setResult(records);
        };
      });
    }

    function updateDuration(id, durationMs) {
      if (durationMs === null || durationMs === undefined) return Promise.resolve(false);
      var normalizedDuration = Number(durationMs);
      if (!Number.isFinite(normalizedDuration) || normalizedDuration < 0) return Promise.resolve(false);
      return transact('readwrite', function (objectStore, setResult) {
        var getRequest = objectStore.get(String(id));
        getRequest.onsuccess = function () {
          var record = getRequest.result;
          if (!record) {
            setResult(false);
            return;
          }
          record.durationMs = normalizedDuration;
          var putRequest = objectStore.put(record);
          putRequest.onsuccess = function () { setResult(true); };
        };
      });
    }

    function deleteRecording(id) {
      return transact('readwrite', function (objectStore, setResult) {
        var request = objectStore.delete(String(id));
        request.onsuccess = function () { setResult(true); };
      });
    }

    function close() {
      if (!databasePromise) return Promise.resolve();
      return databasePromise.then(function (database) {
        database.close();
        databasePromise = null;
      });
    }

    return {
      saveRecording: saveRecording,
      listRecordings: listRecordings,
      updateDuration: updateDuration,
      deleteRecording: deleteRecording,
      close: close
    };
  }

  return {
    createStore: createStore,
    createRecordingId: createRecordingId,
    MAX_WINDOWS_BYTES: MAX_WINDOWS_BYTES
  };
});
