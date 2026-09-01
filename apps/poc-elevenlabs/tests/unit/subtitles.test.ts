import { describe, expect, it } from "vitest";
import { createSrt, toSrtTimestamp } from "../../src/subtitles.js";

describe("SRT generation", () => {
  it("rounds timestamps and preserves normalized Unicode", () => {
    const srt = createSrt([
      {
        id: "2",
        speakerId: "speaker",
        startSeconds: 2.3456,
        endSeconds: 3.1,
        sourceText: "Welcome",
        translation: "हिन्दी स्वागत",
      },
      {
        id: "1",
        speakerId: "speaker",
        startSeconds: 0,
        endSeconds: 1.9995,
        sourceText: "Welcome",
        translation: "  اردو خوش آمدید  ",
      },
    ]);
    expect(srt).toContain("00:00:00,000 --> 00:00:02,000\nاردو خوش آمدید");
    expect(srt).toContain("00:00:02,346 --> 00:00:03,100\nहिन्दी स्वागत");
    expect(srt.indexOf("اردو")).toBeLessThan(srt.indexOf("हिन्दी"));
  });

  it("rejects empty translations and invalid ranges", () => {
    expect(() =>
      createSrt([
        {
          id: "empty",
          speakerId: "speaker",
          startSeconds: 0,
          endSeconds: 1,
          sourceText: "Hello",
          translation: " ",
        },
      ]),
    ).toThrow(/no translation/u);
    expect(() => toSrtTimestamp(-1)).toThrow(/timestamp/u);
  });
});
