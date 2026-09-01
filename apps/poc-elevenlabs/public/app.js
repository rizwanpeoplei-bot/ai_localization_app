const form = document.querySelector("#localization-form");
const submitButton = document.querySelector("#submit-button");
const formError = document.querySelector("#form-error");
const sourceLanguage = document.querySelector("#sourceLanguage");
const targetLanguage = document.querySelector("#targetLanguage");
const provider = document.querySelector("#provider");
const billableRow = document.querySelector("#billable-row");
const providerNotice = document.querySelector("#provider-notice");
const states = ["empty-state", "progress-state", "result-state", "failed-state"];
let pollTimer;

function showState(id) {
  states.forEach((state) => document.querySelector(`#${state}`).classList.toggle("hidden", state !== id));
}

function updateLanguageOptions() {
  [...targetLanguage.options].forEach((option) => {
    option.disabled = option.value === sourceLanguage.value;
  });
  if (targetLanguage.value === sourceLanguage.value) {
    targetLanguage.value = [...targetLanguage.options].find((option) => !option.disabled)?.value ?? "";
  }
}

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode;
    document.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelector("#url-input").classList.toggle("hidden", mode !== "url");
    document.querySelector("#upload-input").classList.toggle("hidden", mode !== "upload");
    document.querySelector("#videoUrl").disabled = mode !== "url";
    document.querySelector("#video").disabled = mode !== "upload";
  });
});

function updateProviderUi() {
  const isLive = provider.value === "elevenlabs";
  billableRow.classList.toggle("hidden", !isLive);
  providerNotice.classList.toggle("live", isLive);
  providerNotice.textContent = isLive
    ? "ElevenLabs performs real voice translation. A configured API key is required and the request may incur charges."
    : "Mock mode does not translate the voice. It reuses the original audio and creates one sample subtitle to test the workflow.";
  submitButton.querySelector("span").textContent = isLive
    ? "Generate translated video"
    : "Test workflow — no translation";
}

sourceLanguage.addEventListener("change", updateLanguageOptions);
provider.addEventListener("change", updateProviderUi);
updateLanguageOptions();
updateProviderUi();

[
  ["logoSizePercent", "logo-size-value", (value) => `${value}%`],
  ["brightness", "brightness-value", (value) => Number(value) > 0 ? `+${value}` : value],
  ["volumePercent", "volume-value", (value) => `${value}%`],
].forEach(([inputId, outputId, format]) => {
  const input = document.querySelector(`#${inputId}`);
  const output = document.querySelector(`#${outputId}`);
  input.addEventListener("input", () => { output.value = format(input.value); });
});

async function readJson(response) {
  const payload = await response.json().catch(() => ({ message: "The server returned an invalid response." }));
  if (!response.ok) throw new Error(payload.message ?? payload.code ?? "Request failed");
  return payload;
}

function renderResult(job) {
  showState("result-state");
  const resultNotice = document.querySelector("#result-provider-notice");
  const isMock = job.result.provider === "mock";
  document.querySelector("#result-title").textContent = isMock ? "Workflow test ready" : "Localized video ready";
  resultNotice.classList.toggle("hidden", !isMock);
  resultNotice.textContent = isMock
    ? "Workflow test only: the voice in this output is the original source audio, not a translation."
    : "";
  const video = document.querySelector("#result-video");
  video.src = job.result.previewUrl;
  document.querySelector("#result-meta").textContent = `${job.result.pair.toUpperCase()} · Run ${job.result.runId}`;
  const links = [
    ["Download final MP4", job.result.previewUrl],
    ["Dubbed MP4", job.result.localizedUrl],
    ["Quality scorecard", job.result.scorecardUrl],
  ];
  if (job.result.subtitledUrl) links.splice(2, 0, ["Subtitle preview", job.result.subtitledUrl]);
  if (job.result.subtitleUrl) links.splice(links.length - 1, 0, ["Download SRT", job.result.subtitleUrl]);
  document.querySelector("#download-links").replaceChildren(...links.map(([label, href]) => {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = label;
    anchor.download = "";
    return anchor;
  }));
}

async function pollJob(id) {
  clearTimeout(pollTimer);
  try {
    const job = await readJson(await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" }));
    document.querySelector("#job-stage").textContent = job.stage;
    if (job.status === "completed") {
      submitButton.disabled = false;
      renderResult(job);
      return;
    }
    if (job.status === "failed") {
      submitButton.disabled = false;
      document.querySelector("#failure-code").textContent = job.error?.code ?? "Generation failed";
      document.querySelector("#failure-message").textContent = job.error?.message ?? "Unknown error";
      showState("failed-state");
      return;
    }
    pollTimer = setTimeout(() => void pollJob(id), 1500);
  } catch (error) {
    document.querySelector("#job-stage").textContent = error.message;
    pollTimer = setTimeout(() => void pollJob(id), 3000);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  submitButton.disabled = true;
  showState("progress-state");
  document.querySelector("#job-stage").textContent = "Submitting";
  try {
    const job = await readJson(await fetch("/api/jobs", { method: "POST", body: new FormData(form) }));
    await pollJob(job.id);
  } catch (error) {
    submitButton.disabled = false;
    formError.textContent = error.message;
    showState("empty-state");
  }
});

document.querySelector("#try-again").addEventListener("click", () => {
  showState("empty-state");
  form.scrollIntoView({ behavior: "smooth" });
});
