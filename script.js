/* =====================================================================
   LinguaBridge - Language Translation Tool
   Sections:
   1. Configuration
   2. Translation API code (kept separate and easy to maintain)
   3. User interface code
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. CONFIGURATION
   --------------------------------------------------------------------- */

const API_URL = "https://api.mymemory.translated.net/get";

// MyMemory accepts about 500 bytes of text per request.
const MAX_BYTES = 500;

// Stop waiting for the API after 15 seconds.
const REQUEST_TIMEOUT_MS = 15000;

// OPTIONAL: a real email address raises the free daily limit (see README).
// Leave empty if you do not want to share an email. It is NOT a secret key.
const CONTACT_EMAIL = "";

// Language codes follow what MyMemory expects (ISO codes, e.g. zh-CN).
const LANGUAGES = [
  { code: "en",    name: "English" },
  { code: "ur",    name: "Urdu" },
  { code: "ar",    name: "Arabic" },
  { code: "hi",    name: "Hindi" },
  { code: "fr",    name: "French" },
  { code: "es",    name: "Spanish" },
  { code: "de",    name: "German" },
  { code: "zh-CN", name: "Chinese (Simplified)" },
  { code: "pt",    name: "Portuguese" },
  { code: "ru",    name: "Russian" },
  { code: "ja",    name: "Japanese" },
  { code: "ko",    name: "Korean" },
  { code: "it",    name: "Italian" },
  { code: "tr",    name: "Turkish" },
  { code: "bn",    name: "Bengali" },
  { code: "fa",    name: "Persian" },
  { code: "nl",    name: "Dutch" }
];

// Languages written right-to-left (output box direction is adjusted).
const RTL_LANGUAGES = ["ar", "ur", "fa"];

/* ---------------------------------------------------------------------
   2. TRANSLATION API CODE
   --------------------------------------------------------------------- */

// A custom error type whose message is safe to show directly to the user.
class TranslationError extends Error {}

/** Count how many bytes a string uses (non-Latin letters use 2-3 bytes). */
function getByteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * MyMemory sometimes returns HTML entities such as &#39; in the result.
 * DOMParser converts them to normal characters WITHOUT running any scripts
 * and without inserting anything into the page.
 */
function decodeHtmlEntities(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  return doc.documentElement.textContent || "";
}

/** Turn an API status code into a friendly message. */
function getFriendlyApiError(status, details) {
  if (status === 429) {
    return "The free daily translation limit has been reached. Please try again tomorrow.";
  }
  if (status === 403) {
    return "The API rejected this language pair. Try choosing the source language manually instead of Auto Detect.";
  }
  if (status === 400) {
    return "The request was invalid. Please check your text and selected languages.";
  }
  if (status >= 500) {
    return "The translation service is having problems. Please try again in a moment.";
  }
  return details
    ? "Translation failed: " + decodeHtmlEntities(String(details))
    : "Translation failed for an unknown reason. Please try again.";
}

/**
 * Sends text to MyMemory and returns { text, detectedLanguage }.
 * Throws TranslationError with a friendly message if anything goes wrong.
 */
async function translateText(text, sourceLang, targetLang) {
  // MyMemory uses "Autodetect" as a special source language.
  const sourceCode = sourceLang === "auto" ? "Autodetect" : sourceLang;

  // URLSearchParams properly encodes the user's text for the URL.
  const params = new URLSearchParams({
    q: text,
    langpair: sourceCode + "|" + targetLang
  });
  if (CONTACT_EMAIL) {
    params.set("de", CONTACT_EMAIL);
  }

  // AbortController lets us cancel a request that takes too long.
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(API_URL + "?" + params.toString(), { signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new TranslationError("The request took too long. Please check your connection and try again.");
    }
    throw new TranslationError("Network error. Please check your internet connection and try again.");
  } finally {
    clearTimeout(timerId);
  }

  // Check the HTTP status (200-299 means OK).
  if (!response.ok) {
    throw new TranslationError(getFriendlyApiError(response.status));
  }

  // Parse JSON safely.
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new TranslationError("The translation service sent an unreadable response.");
  }

  // MyMemory also reports its own status inside the JSON (number or string).
  const apiStatus = Number(data && data.responseStatus);
  if (apiStatus !== 200) {
    throw new TranslationError(getFriendlyApiError(apiStatus, data && data.responseDetails));
  }

  // Validate and extract the translated text.
  const translated = data.responseData && data.responseData.translatedText;
  if (typeof translated !== "string" || translated.trim() === "") {
    throw new TranslationError("The translation service returned an empty result. Try different text.");
  }

  return {
    text: decodeHtmlEntities(translated),
    // Only present when the API reports it (usually with Auto Detect).
    detectedLanguage: (data.responseData && data.responseData.detectedLanguage) || ""
  };
}

/* ---------------------------------------------------------------------
   3. USER INTERFACE CODE
   --------------------------------------------------------------------- */

// Grab page elements once.
const sourceSelect   = document.getElementById("sourceLang");
const targetSelect   = document.getElementById("targetLang");
const swapBtn        = document.getElementById("swapBtn");
const inputText      = document.getElementById("inputText");
const outputText     = document.getElementById("outputText");
const charCounter    = document.getElementById("charCounter");
const detectedInfo   = document.getElementById("detectedInfo");
const clearBtn       = document.getElementById("clearBtn");
const copyBtn        = document.getElementById("copyBtn");
const translateBtn   = document.getElementById("translateBtn");
const translateLabel = document.getElementById("translateLabel");
const spinner        = document.getElementById("spinner");
const statusMessage  = document.getElementById("statusMessage");

const OUTPUT_PLACEHOLDER = "Your translation will appear here.";

// Remember the current result so Copy and Swap can use it.
let currentTranslation = "";
let detectedLangCode = "";

/** Fill both <select> elements with the language list. */
function populateLanguages() {
  const autoOption = new Option("Auto Detect Language", "auto");
  sourceSelect.add(autoOption);

  LANGUAGES.forEach((lang) => {
    sourceSelect.add(new Option(lang.name, lang.code));
    targetSelect.add(new Option(lang.name, lang.code));
  });

  sourceSelect.value = "auto";
  targetSelect.value = "ur"; // sensible default for this project
}

/** Find a language in our list from a code returned by the API. */
function findLanguage(code) {
  const wanted = code.toLowerCase();
  const wantedBase = wanted.split("-")[0];
  return (
    LANGUAGES.find((l) => l.code.toLowerCase() === wanted) ||
    LANGUAGES.find((l) => l.code.toLowerCase().split("-")[0] === wantedBase)
  );
}

/** Show a message. type = "error" | "success" | "info" */
function showMessage(text, type) {
  statusMessage.textContent = text; // textContent = safe, no HTML injection
  statusMessage.className = "status " + type;
  statusMessage.setAttribute("role", type === "error" ? "alert" : "status");
  statusMessage.hidden = false;
}

function hideMessage() {
  statusMessage.hidden = true;
  statusMessage.textContent = "";
}

/** Update the character / byte counter. */
function updateCounter() {
  const text = inputText.value;
  const bytes = getByteLength(text);
  charCounter.textContent = text.length + " characters · " + bytes + " / " + MAX_BYTES + " bytes";
  charCounter.classList.toggle("is-over-limit", bytes > MAX_BYTES);
}

/** Show a translation (or the placeholder) in the output box. */
function showOutput(text) {
  currentTranslation = text;
  const hasText = text !== "";

  outputText.textContent = hasText ? text : OUTPUT_PLACEHOLDER;
  outputText.classList.toggle("is-placeholder", !hasText);
  copyBtn.disabled = !hasText;

  // Right-to-left languages should read correctly.
  outputText.dir = RTL_LANGUAGES.includes(targetSelect.value) ? "rtl" : "ltr";
}

/** Turn the loading state on or off. */
function setLoading(isLoading) {
  translateBtn.disabled = isLoading;
  spinner.hidden = !isLoading;
  translateLabel.textContent = isLoading ? "Translating..." : "Translate";
  translateBtn.setAttribute("aria-busy", String(isLoading));
}

/** Main action: validate, call the API, display the result. */
async function handleTranslate() {
  const text = inputText.value.trim();
  const sourceLang = sourceSelect.value;
  const targetLang = targetSelect.value;

  hideMessage();
  detectedInfo.textContent = "";
  detectedLangCode = "";

  // --- Validation before sending any request ---
  if (text === "") {
    showMessage("Please enter some text to translate.", "error");
    inputText.focus();
    return;
  }
  if (getByteLength(text) > MAX_BYTES) {
    showMessage(
      "Your text is too long. The free API accepts about " + MAX_BYTES +
      " bytes per request (non-Latin scripts use more bytes per character). Please shorten it.",
      "error"
    );
    return;
  }
  if (sourceLang === targetLang) {
    showMessage("The source and target languages are the same. Please choose different languages.", "error");
    return;
  }

  setLoading(true);
  try {
    const result = await translateText(text, sourceLang, targetLang);
    showOutput(result.text);

    // If Auto Detect was used and the API told us the language, show it.
    if (sourceLang === "auto" && result.detectedLanguage) {
      detectedLangCode = result.detectedLanguage;
      const found = findLanguage(result.detectedLanguage);
      detectedInfo.textContent = "Detected: " + (found ? found.name : result.detectedLanguage);
    }
  } catch (error) {
    // TranslationError messages are friendly; anything else gets a generic message.
    const message = error instanceof TranslationError
      ? error.message
      : "Something unexpected went wrong. Please try again.";
    showMessage(message, "error");
    console.error(error);
  } finally {
    // Always restore the button, success or failure.
    setLoading(false);
  }
}

/** Swap source and target languages (and move the text across). */
function handleSwap() {
  let newTarget = sourceSelect.value;

  // With Auto Detect we can only swap if the language was detected.
  if (newTarget === "auto") {
    const detected = detectedLangCode ? findLanguage(detectedLangCode) : null;
    if (!detected) {
      showMessage("Choose a specific source language (or translate once with Auto Detect) before swapping.", "info");
      return;
    }
    newTarget = detected.code;
  }

  const newSource = targetSelect.value;
  sourceSelect.value = newSource;
  targetSelect.value = newTarget;

  // Move the translation into the input box so the user can translate back.
  if (currentTranslation !== "") {
    inputText.value = currentTranslation;
    showOutput("");
    detectedInfo.textContent = "";
    detectedLangCode = "";
  }

  hideMessage();
  updateCounter();
}

/** Clear everything. */
function handleClear() {
  inputText.value = "";
  showOutput("");
  detectedInfo.textContent = "";
  detectedLangCode = "";
  hideMessage();
  updateCounter();
  inputText.focus();
}

/** Copy the translation to the clipboard. */
async function handleCopy() {
  if (currentTranslation === "") return;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(currentTranslation);
    } else {
      copyWithFallback(currentTranslation); // for file:// or older browsers
    }
    showMessage("Translation copied to clipboard.", "success");
  } catch (error) {
    showMessage("Could not copy automatically. Please select the text and copy it manually.", "error");
  }
}

/** Older way of copying text, used when the Clipboard API is unavailable. */
function copyWithFallback(text) {
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "");
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  document.body.appendChild(temp);
  temp.select();
  const worked = document.execCommand("copy");
  document.body.removeChild(temp);
  if (!worked) {
    throw new Error("Copy command failed");
  }
}

/* ---------- Connect everything ---------- */
populateLanguages();
showOutput("");
updateCounter();

translateBtn.addEventListener("click", handleTranslate);
swapBtn.addEventListener("click", handleSwap);
clearBtn.addEventListener("click", handleClear);
copyBtn.addEventListener("click", handleCopy);
inputText.addEventListener("input", updateCounter);

// Ctrl + Enter translates from inside the text box.
inputText.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Enter") {
    handleTranslate();
  }
});

// Changing the target language fixes the text direction of the old result.
targetSelect.addEventListener("change", () => {
  outputText.dir = RTL_LANGUAGES.includes(targetSelect.value) ? "rtl" : "ltr";
});