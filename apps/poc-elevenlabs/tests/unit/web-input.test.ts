import { describe, expect, it } from "vitest";
import { WebSubmissionSchema } from "../../src/web-input.js";

const baseInput = {
  videoUrl: "https://media.example.com/source.mp4",
  sourceLanguage: "en",
  targetLanguage: "ur",
  provider: "mock",
  preserveVoice: "on",
  subtitleMode: "burned",
  brightness: "0",
  volumePercent: "100",
  logoPosition: "bottom-right",
  logoSizePercent: "15",
};

describe("web submission", () => {
  it("normalizes browser form values", () => {
    const parsed = WebSubmissionSchema.parse(baseInput);
    expect(parsed).toMatchObject({
      sourceLanguage: "en",
      targetLanguage: "ur",
      preserveVoice: true,
      confirmBillable: false,
      confirmSourceRights: false,
      brightness: 0,
      volumePercent: 100,
      logoSizePercent: 15,
    });
  });

  it("rejects identical languages and unsafe media ranges", () => {
    expect(() =>
      WebSubmissionSchema.parse({
        ...baseInput,
        targetLanguage: "en",
        brightness: "51",
        volumePercent: "201",
      }),
    ).toThrow();
  });
});
