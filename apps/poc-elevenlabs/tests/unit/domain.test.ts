import { describe, expect, it } from "vitest";
import {
  assertLanguagePair,
  LanguageSchema,
  MatrixConfigSchema,
  type Language,
} from "../../src/domain.js";

describe("language validation", () => {
  it("accepts all six cross-language pairs", () => {
    const languages = LanguageSchema.options;
    const pairs = languages.flatMap((source) =>
      languages.filter((target) => target !== source).map((target) => [source, target] as const),
    );
    expect(pairs).toHaveLength(6);
    for (const [source, target] of pairs) {
      expect(() => assertLanguagePair(source, target)).not.toThrow();
    }
  });

  it.each(LanguageSchema.options)("rejects %s to itself", (language) => {
    expect(() => assertLanguagePair(language, language)).toThrow(/must differ/u);
  });

  it("requires a complete three-source matrix", () => {
    const source = (sourceLanguage: Language, targets: [Language, Language]) => ({
      id: `${sourceLanguage}-source`,
      input: `input/${sourceLanguage}.mp4`,
      sourceLanguage,
      targets,
    });
    expect(
      MatrixConfigSchema.parse({
        version: 1,
        sources: [source("en", ["ur", "hi"]), source("ur", ["en", "hi"]), source("hi", ["en", "ur"])],
      }).sources,
    ).toHaveLength(3);
    expect(() =>
      MatrixConfigSchema.parse({
        version: 1,
        sources: [source("en", ["ur", "hi"]), source("ur", ["en", "hi"]), source("ur", ["en", "hi"])],
      }),
    ).toThrow();
  });
});
