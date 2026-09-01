import type { TranscriptSegment } from "./domain.js";
import { PocError } from "./errors.js";

function toSrtTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new PocError("INVALID_TRANSCRIPT_TIME", `Invalid transcript timestamp: ${seconds}`);
  }
  const milliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainingMilliseconds = milliseconds % 1_000;
  return [hours, minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":")
    .concat(",", String(remainingMilliseconds).padStart(3, "0"));
}

function normalizeSubtitleText(text: string): string {
  return text
    .normalize("NFC")
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function createSrt(segments: TranscriptSegment[]): string {
  const sorted = [...segments].sort((left, right) => left.startSeconds - right.startSeconds);
  return `${sorted
    .map((segment, index) => {
      const translation = normalizeSubtitleText(segment.translation);
      if (!translation) {
        throw new PocError("TRANSCRIPT_TRANSLATION_MISSING", `Segment ${segment.id} has no translation`);
      }
      if (segment.endSeconds <= segment.startSeconds) {
        throw new PocError("INVALID_TRANSCRIPT_TIME", `Segment ${segment.id} has an invalid time range`);
      }
      return [
        String(index + 1),
        `${toSrtTimestamp(segment.startSeconds)} --> ${toSrtTimestamp(segment.endSeconds)}`,
        translation,
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

export { toSrtTimestamp };
