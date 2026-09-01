import type { Language } from "./domain.js";

export interface QualityScorecard {
  version: 1;
  sourceLanguage: Language;
  targetLanguage: Language;
  reviewer: string | null;
  reviewedAt: string | null;
  dimensions: Record<
    | "translationAccuracy"
    | "pronunciationNaturalness"
    | "synchronization"
    | "speakerSimilarity"
    | "backgroundPreservation"
    | "subtitleAccuracyTiming"
    | "subtitleReadability",
    number | null
  >;
  criticalDefects: string[];
  notes: string;
  decision: "PENDING" | "PASS" | "FAIL";
  gate: {
    minimumAverage: 4;
    minimumDimension: 3;
    criticalDefectsAllowed: 0;
  };
}

export function createBlankScorecard(source: Language, target: Language): QualityScorecard {
  return {
    version: 1,
    sourceLanguage: source,
    targetLanguage: target,
    reviewer: null,
    reviewedAt: null,
    dimensions: {
      translationAccuracy: null,
      pronunciationNaturalness: null,
      synchronization: null,
      speakerSimilarity: null,
      backgroundPreservation: null,
      subtitleAccuracyTiming: null,
      subtitleReadability: null,
    },
    criticalDefects: [],
    notes: "",
    decision: "PENDING",
    gate: {
      minimumAverage: 4,
      minimumDimension: 3,
      criticalDefectsAllowed: 0,
    },
  };
}
