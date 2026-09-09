const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
  constructor(initial = '') { this.values = new Set(initial.split(/\s+/).filter(Boolean)); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id = '', className = '') {
    this.id = id;
    this.className = className;
    this.classList = new FakeClassList(className);
    this.dataset = {};
    this.disabled = false;
    this.textContent = '';
    this.listeners = {};
    this.children = [];
    this.style = {};
    this.value = '';
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  click() { if (!this.disabled && this.listeners.click) this.listeners.click({ currentTarget: this }); }
  appendChild(child) { this.children.push(child); return child; }
  focus() {}
  removeAttribute() {}
  load() {}
}

const elements = new Map([
  ['startBtn', new FakeElement('startBtn', 'start')],
  ['stopBtn', new FakeElement('stopBtn', 'stop hidden')],
  ['retryBtn', new FakeElement('retryBtn', 'retry hidden')],
  ['audioInput', new FakeElement('audioInput')],
  ['statusDot', new FakeElement('statusDot', 'dot')],
  ['statusText', new FakeElement('statusText')],
  ['timer', new FakeElement('timer')],
  ['message', new FakeElement('message', 'note message info')],
  ['recordingList', new FakeElement('recordingList')],
  ['recordCount', new FakeElement('recordCount')]
]);

const document = {
  documentElement: { dataset: {} },
  visibilityState: 'visible',
  getElementById(id) { return elements.get(id); },
  createElement() { return new FakeElement(); },
  addEventListener() {}
};

let saveCalls = 0;
const fakeStore = {
  listRecordings: () => Promise.resolve([]),
  saveRecording: (record) => {
    saveCalls += 1;
    return Promise.resolve({ ...record, size: record.blob.size });
  },
  updateDuration: () => Promise.resolve(false),
  deleteRecording: () => Promise.resolve(true)
};

const tracks = [];
function makeStream() {
  const track = { stopCalls: 0, stop() { this.stopCalls += 1; } };
  tracks.push(track);
  return { getTracks: () => [track] };
}

let getUserMedia = () => Promise.resolve(makeStream());
let wakeReleaseCalls = 0;
const intervalIds = new Set();
let nextIntervalId = 1;

const navigator = {
  mediaDevices: { getUserMedia: (...args) => getUserMedia(...args) },
  storage: { persist: () => Promise.resolve(true) },
  wakeLock: {
    request: () => Promise.resolve({
      release: () => {
        wakeReleaseCalls += 1;
        return Promise.resolve();
      }
    })
  }
};

const windowObject = {
  MeetingMinutesRecordings: {
    createStore: () => fakeStore,
    createRecordingId: (() => { let id = 0; return () => `test-${++id}`; })(),
    MAX_WINDOWS_BYTES: 25 * 1024 * 1024
  },
  confirm: () => true,
  addEventListener() {},
  navigator,
  MediaRecorder: null
};

const context = vm.createContext({
  window: windowObject,
  document,
  navigator,
  Blob,
  File,
  URL,
  Intl,
  Map,
  Promise,
  Number,
  Date,
  Math,
  String,
  setTimeout,
  clearTimeout,
  setInterval: () => {
    const id = nextIntervalId++;
    intervalIds.add(id);
    return id;
  },
  clearInterval: (id) => intervalIds.delete(id),
  console
});

function setMediaRecorder(RecorderClass) {
  context.MediaRecorder = RecorderClass;
  windowObject.MediaRecorder = RecorderClass;
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
vm.runInContext(source, context, { filename: 'app.js' });

(async () => {
  await tick();
  assert.equal(document.documentElement.dataset.appReady, 'true');

  function ConstructorFailure() { throw new Error('constructor failure'); }
  ConstructorFailure.isTypeSupported = () => false;
  setMediaRecorder(ConstructorFailure);
  const constructorTrackIndex = tracks.length;
  elements.get('startBtn').click();
  await tick();
  assert.equal(tracks[constructorTrackIndex].stopCalls, 1, 'constructor failure left microphone track active');
  assert.equal(intervalIds.size, 0, 'constructor failure left a timer active');
  assert.equal(saveCalls, 0, 'constructor failure saved a recording');

  class StartFailureRecorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; this.listeners = {}; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    start() { throw new Error('start failure'); }
  }
  StartFailureRecorder.isTypeSupported = () => false;
  setMediaRecorder(StartFailureRecorder);
  const startTrackIndex = tracks.length;
  elements.get('startBtn').click();
  await tick();
  assert.equal(tracks[startTrackIndex].stopCalls, 1, 'start failure left microphone track active');
  assert.equal(intervalIds.size, 0, 'start failure left a timer active');
  assert.equal(saveCalls, 0, 'start failure saved a recording');

  const recorderInstances = [];
  class ErrorThenStopRecorder {
    constructor() {
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
      this.listeners = {};
      recorderInstances.push(this);
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    start() { this.state = 'recording'; }
    emit(type, event = {}) { if (this.listeners[type]) this.listeners[type](event); }
  }
  ErrorThenStopRecorder.isTypeSupported = () => true;
  setMediaRecorder(ErrorThenStopRecorder);
  const errorTrackIndex = tracks.length;
  elements.get('startBtn').click();
  await tick();
  const failedRecorder = recorderInstances.at(-1);
  failedRecorder.emit('error', { error: new Error('synthetic recorder error') });
  failedRecorder.emit('dataavailable', { data: new Blob(['partial'], { type: 'audio/webm' }) });
  failedRecorder.state = 'inactive';
  failedRecorder.emit('stop');
  await tick();

  assert.equal(tracks[errorTrackIndex].stopCalls, 1, 'recorder error left microphone track active');
  assert.equal(intervalIds.size, 0, 'recorder error left a timer active');
  assert.equal(saveCalls, 0, 'error followed by dataavailable/stop saved a partial recording');
  assert.match(elements.get('message').textContent, /לא נשמר קובץ חלקי/);
  assert.ok(wakeReleaseCalls >= 1, 'recorder error did not release wake lock');

  console.log('PASS: MediaRecorder constructor/start cleanup and error-then-stop suppression');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
