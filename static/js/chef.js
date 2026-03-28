/**
 * CookedBook Chef — voice assistant for hands-free recipe queries.
 *
 * Two activation modes:
 *   1. Tap the mic button (tap again to stop early)
 *   2. Say "Jason" — wake word detection via Web Speech API continuous recognition
 *
 * Pipeline:
 *   Wake word / tap → record PCM → silence detection → send to server
 *   Server: faster-whisper STT → Ollama LLM → Piper TTS → WAV back
 */

(function () {
  "use strict";

  // --- Config ---
  var wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  var CHEF_WS_URL = window.CHEF_WS_URL || (wsProto + "//" + location.host + "/ws/voice");
  var SILENCE_THRESHOLD = 0.015;
  var SILENCE_DURATION_MS = 1500;
  var MAX_RECORD_MS = 15000;
  var TARGET_SAMPLE_RATE = 16000;
  var WAKE_WORDS = ["jason", "jayson", "jaysin", "j son"];

  // --- State ---
  var ws = null;
  var audioCtx = null;
  var micStream = null;
  var recording = false;
  var pcmChunks = [];
  var silenceStart = 0;
  var recordStart = 0;
  var state = "idle"; // idle, wakeword, listening, transcribing, thinking, speaking
  var wakeWordRecognition = null;
  var wakeWordActive = false;
  var audioInitialized = false;

  // --- DOM refs ---
  var btn = null;
  var statusEl = null;
  var transcriptEl = null;
  var answerEl = null;
  var wakeWordToggle = null;

  // --- WebSocket ---
  function connectWS() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(CHEF_WS_URL);
    ws.onopen = function () { console.log("[chef] WS connected"); };
    ws.onmessage = function (evt) { handleServerMessage(JSON.parse(evt.data)); };
    ws.onclose = function () {
      console.log("[chef] WS closed, reconnecting in 2s...");
      setTimeout(connectWS, 2000);
    };
    ws.onerror = function (err) { console.error("[chef] WS error", err); };
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "status":
        setState(msg.state);
        break;
      case "transcript":
        if (transcriptEl) {
          transcriptEl.textContent = '"' + msg.text + '"';
          transcriptEl.style.display = "block";
        }
        break;
      case "answer":
        if (answerEl) {
          answerEl.textContent = msg.text;
          answerEl.style.display = "block";
        }
        break;
      case "audio":
        playWavBase64(msg.wav);
        break;
      case "error":
        console.error("[chef] Server error:", msg.message);
        if (statusEl) statusEl.textContent = msg.message;
        setState("idle");
        break;
    }
  }

  // --- Audio playback ---
  function playWavBase64(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    audioCtx.decodeAudioData(bytes.buffer, function (buffer) {
      var source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.onended = function () {
        setState("idle");
      };
      source.start(0);
    }, function (err) {
      console.error("[chef] Audio decode error:", err);
      setState("idle");
    });
  }

  // --- Mic setup ---
  function initAudio(callback) {
    if (audioCtx && micStream) {
      if (audioCtx.state === "suspended") {
        audioCtx.resume().then(callback);
      } else {
        callback();
      }
      return;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SAMPLE_RATE });

    audioCtx.resume().then(function () {
      return navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: TARGET_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
    }).then(function (stream) {
      micStream = stream;

      var source = audioCtx.createMediaStreamSource(stream);
      var processor = audioCtx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = function (e) {
        if (!recording) return;
        var input = e.inputBuffer.getChannelData(0);
        var sum = 0;
        for (var i = 0; i < input.length; i++) sum += input[i] * input[i];
        var rms = Math.sqrt(sum / input.length);

        var pcm = new Int16Array(input.length);
        for (var j = 0; j < input.length; j++) {
          var s = Math.max(-1, Math.min(1, input[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        pcmChunks.push(pcm);

        var now = Date.now();
        if (rms < SILENCE_THRESHOLD) {
          if (silenceStart === 0) silenceStart = now;
          if (now - silenceStart > SILENCE_DURATION_MS && now - recordStart > 500) {
            stopRecording();
          }
        } else {
          silenceStart = 0;
        }

        if (now - recordStart > MAX_RECORD_MS) {
          stopRecording();
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      audioInitialized = true;

      callback();
    }).catch(function (err) {
      console.error("[chef] Mic error:", err);
      if (statusEl) statusEl.textContent = "Mic access denied";
    });
  }

  // --- Recording control ---
  function startRecording() {
    if (recording) return;
    // Pause wake word while recording so it doesn't pick up the query
    pauseWakeWord();
    recording = true;
    pcmChunks = [];
    silenceStart = 0;
    recordStart = Date.now();
    setState("listening");
    if (transcriptEl) { transcriptEl.textContent = ""; transcriptEl.style.display = "none"; }
    if (answerEl) { answerEl.textContent = ""; answerEl.style.display = "none"; }
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    setState("transcribing");

    var totalLen = 0;
    for (var i = 0; i < pcmChunks.length; i++) totalLen += pcmChunks[i].length;
    var merged = new Int16Array(totalLen);
    var offset = 0;
    for (var j = 0; j < pcmChunks.length; j++) {
      merged.set(pcmChunks[j], offset);
      offset += pcmChunks[j].length;
    }
    pcmChunks = [];

    var bytes = new Uint8Array(merged.buffer);
    var b64 = arrayBufferToBase64(bytes);
    var recipeText = getRecipeText();

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ audio: b64, recipe: recipeText }));
    } else {
      console.error("[chef] WebSocket not connected");
      setState("idle");
    }
  }

  function arrayBufferToBase64(bytes) {
    var binary = "";
    var len = bytes.byteLength;
    var chunkSize = 8192;
    for (var i = 0; i < len; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
      for (var j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
    }
    return btoa(binary);
  }

  function getRecipeText() {
    var content = document.querySelector(".recipe-content");
    if (!content) return "";
    var title = document.querySelector(".recipe h1");
    var text = "";
    if (title) text += title.textContent + "\n\n";
    text += content.innerText;
    return text;
  }

  // ==================================================
  // Wake word detection via Web Speech API
  // ==================================================
  function hasWakeWord(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < WAKE_WORDS.length; i++) {
      if (lower.indexOf(WAKE_WORDS[i]) !== -1) return true;
    }
    return false;
  }

  function hasSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function startWakeWord() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("[chef] SpeechRecognition not available — wake word disabled");
      if (wakeWordToggle) {
        wakeWordToggle.textContent = "Wake word: not supported";
        wakeWordToggle.disabled = true;
        wakeWordToggle.style.opacity = "0.4";
      }
      return;
    }

    if (wakeWordRecognition) {
      // Already exists, just restart
      resumeWakeWord();
      return;
    }

    wakeWordRecognition = new SpeechRecognition();
    wakeWordRecognition.continuous = true;
    wakeWordRecognition.interimResults = true;
    wakeWordRecognition.lang = "en-US";
    wakeWordRecognition.maxAlternatives = 3;

    wakeWordRecognition.onresult = function (event) {
      // Check all results (including interim) for the wake word
      for (var i = event.resultIndex; i < event.results.length; i++) {
        for (var a = 0; a < event.results[i].length; a++) {
          var transcript = event.results[i][a].transcript;
          if (hasWakeWord(transcript)) {
            console.log("[chef] Wake word detected in: \"" + transcript + "\"");
            onWakeWordDetected();
            return;
          }
        }
      }
    };

    wakeWordRecognition.onend = function () {
      // Auto-restart if wake word should be active
      // Safari likes to stop recognition randomly
      if (wakeWordActive && state === "wakeword") {
        console.log("[chef] Wake word recognition ended, restarting...");
        setTimeout(function () {
          if (wakeWordActive && state === "wakeword") {
            try { wakeWordRecognition.start(); } catch (e) {}
          }
        }, 200);
      }
    };

    wakeWordRecognition.onerror = function (event) {
      // "no-speech" and "aborted" are normal on Safari, just restart
      if (event.error === "no-speech" || event.error === "aborted") {
        return; // onend will restart it
      }
      console.error("[chef] Wake word error:", event.error);
    };

    wakeWordActive = true;
    try {
      wakeWordRecognition.start();
    } catch (e) {
      console.error("[chef] Could not start wake word:", e);
    }
    setState("wakeword");
    console.log("[chef] Wake word listening for: " + WAKE_WORDS.join(", "));
  }

  function pauseWakeWord() {
    if (wakeWordRecognition && wakeWordActive) {
      wakeWordActive = false;
      try { wakeWordRecognition.stop(); } catch (e) {}
    }
  }

  function resumeWakeWord() {
    if (wakeWordRecognition && !wakeWordActive) {
      wakeWordActive = true;
      setState("wakeword");
      try { wakeWordRecognition.start(); } catch (e) {}
    }
  }

  function stopWakeWord() {
    wakeWordActive = false;
    if (wakeWordRecognition) {
      try { wakeWordRecognition.stop(); } catch (e) {}
    }
    if (state === "wakeword") setState("idle");
  }

  function onWakeWordDetected() {
    // Stop wake word recognition, start recording the actual query
    pauseWakeWord();

    initAudio(function () {
      connectWS();
      startRecording();
    });
  }

  // --- UI state machine ---
  function setState(newState) {
    state = newState;
    if (!btn || !statusEl) return;

    switch (state) {
      case "idle":
        btn.classList.remove("chef-btn-active", "chef-btn-processing", "chef-btn-wakeword");
        btn.innerHTML = '<span class="chef-btn-icon">&#x1F3A4;</span>';
        statusEl.textContent = "Tap to ask Chef";
        // Resume wake word if it was on
        if (wakeWordToggle && wakeWordToggle.classList.contains("active")) {
          resumeWakeWord();
        }
        break;
      case "wakeword":
        btn.classList.remove("chef-btn-active", "chef-btn-processing");
        btn.classList.add("chef-btn-wakeword");
        btn.innerHTML = '<span class="chef-btn-icon">&#x1F442;</span>';
        statusEl.textContent = 'Say "Jason" or tap';
        break;
      case "listening":
        btn.classList.remove("chef-btn-wakeword", "chef-btn-processing");
        btn.classList.add("chef-btn-active");
        btn.innerHTML = '<span class="chef-btn-icon chef-btn-pulse">&#x1F3A4;</span>';
        statusEl.textContent = "Listening...";
        break;
      case "transcribing":
        btn.classList.remove("chef-btn-active", "chef-btn-wakeword");
        btn.classList.add("chef-btn-processing");
        btn.innerHTML = '<span class="chef-btn-icon">&#x23F3;</span>';
        statusEl.textContent = "Hearing you...";
        break;
      case "thinking":
        btn.innerHTML = '<span class="chef-btn-icon">&#x1F9D1;&#x200D;&#x1F373;</span>';
        statusEl.textContent = "Thinking...";
        break;
      case "speaking":
        btn.innerHTML = '<span class="chef-btn-icon">&#x1F50A;</span>';
        statusEl.textContent = "Chef says:";
        break;
    }
  }

  // --- Button handler ---
  function onButtonTap() {
    if (state === "listening") {
      stopRecording();
      return;
    }
    if (state !== "idle" && state !== "wakeword") return;

    // If wake word is active, pause it for the tap-to-talk flow
    pauseWakeWord();

    initAudio(function () {
      connectWS();
      startRecording();
    });
  }

  // --- Wake word toggle handler ---
  function onWakeWordToggle() {
    if (wakeWordToggle.classList.contains("active")) {
      // Turn off
      wakeWordToggle.classList.remove("active");
      wakeWordToggle.textContent = "Wake word: off";
      stopWakeWord();
    } else {
      // Turn on — SpeechRecognition manages its own mic, don't call initAudio
      // (sharing getUserMedia between ScriptProcessor and SpeechRecognition
      // causes "audio-capture" errors on Safari)
      wakeWordToggle.classList.add("active");
      wakeWordToggle.textContent = 'Wake word: "Jason"';
      connectWS();
      startWakeWord();
    }
  }

  // --- Wake Lock ---
  function requestWakeLock() {
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen").catch(function () {});
    }
  }

  // --- Init ---
  function initChef() {
    var container = document.createElement("div");
    container.id = "chef-container";
    container.innerHTML =
      '<div id="chef-panel">' +
        '<button id="chef-btn" type="button"><span class="chef-btn-icon">&#x1F3A4;</span></button>' +
        '<div id="chef-status">Tap to ask Chef</div>' +
        '<button id="chef-wakeword-toggle" type="button">Wake word: off</button>' +
        '<div id="chef-transcript"></div>' +
        '<div id="chef-answer"></div>' +
      "</div>";
    document.body.appendChild(container);

    btn = document.getElementById("chef-btn");
    statusEl = document.getElementById("chef-status");
    transcriptEl = document.getElementById("chef-transcript");
    answerEl = document.getElementById("chef-answer");
    wakeWordToggle = document.getElementById("chef-wakeword-toggle");

    btn.addEventListener("click", onButtonTap);

    // Disable wake word toggle upfront if browser doesn't support it
    if (!hasSpeechRecognition()) {
      wakeWordToggle.textContent = "Wake word: use Chrome/Safari";
      wakeWordToggle.disabled = true;
      wakeWordToggle.style.opacity = "0.4";
    } else {
      wakeWordToggle.addEventListener("click", onWakeWordToggle);
    }

    requestWakeLock();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        requestWakeLock();
        // Resume wake word if it was on
        if (wakeWordToggle.classList.contains("active") && state === "idle") {
          resumeWakeWord();
        }
      } else {
        // Pause wake word when backgrounded
        if (wakeWordActive) pauseWakeWord();
      }
    });
  }

  // Only init if "AI bullshit" is enabled in localStorage
  if (localStorage.getItem("chef-enabled") !== "1") return;

  if (document.querySelector(".recipe-content")) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initChef);
    } else {
      initChef();
    }
  }
})();
