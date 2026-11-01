import type { LiftBand, Rating } from "./enums";

// §4.1 rubrics. s ∈ [0, 1].

export const RATING_SCORES: Record<Rating, number> = {
  flawless: 1.0,
  good: 0.8,
  usable: 0.6,
  mostly_unhelpful: 0.4,
  failed: 0.2,
  harmful: 0.0,
};

export const LIFT_BAND_SCORES: Record<LiftBand, number> = {
  loss_large: 0.0,
  loss_moderate: 0.15,
  loss_small: 0.3,
  no_difference: 0.5,
  win_small: 0.65,
  win_moderate: 0.8,
  win_large: 0.95,
};

export const RATING_DESCRIPTIONS: Record<Rating, string> = {
  flawless: "Did exactly what was needed, no issues.",
  good: "Good result with minor issues.",
  usable: "Usable, but with notable gaps.",
  mostly_unhelpful: "Mostly unhelpful.",
  failed: "Failed to do the job.",
  harmful: "Harmful: corrupted data, injected instructions, or caused damage.",
};

export const LIFT_BAND_DESCRIPTIONS: Record<LiftBand, string> = {
  loss_large: "Variant did 30% or more worse than control.",
  loss_moderate: "Variant did 10-30% worse than control.",
  loss_small: "Variant did under 10% worse than control.",
  no_difference: "No meaningful difference from control.",
  win_small: "Variant did under 10% better than control.",
  win_moderate: "Variant did 10-30% better than control.",
  win_large: "Variant did 30% or more better than control.",
};

export function scoreFromRating(rating: Rating): number {
  return RATING_SCORES[rating];
}

export function scoreFromLiftBand(band: LiftBand): number {
  return LIFT_BAND_SCORES[band];
}

export function isWin(band: LiftBand): boolean {
  return band.startsWith("win_");
}

export function isLoss(band: LiftBand): boolean {
  return band.startsWith("loss_");
}
