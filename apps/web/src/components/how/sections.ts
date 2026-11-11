/** In-page sections of /how, in order. Ids are the URL anchors. */
export const HOW_SECTIONS = [
  { id: "steps", label: "The six steps" },
  { id: "rule", label: "The clearing rule" },
  { id: "example", label: "Worked example" },
  { id: "visibility", label: "Public vs hidden" },
  { id: "trust", label: "Trust assumptions" },
  { id: "limits", label: "Honest limits" },
  { id: "failures", label: "Failure cases" },
  { id: "fallback", label: "Commit-reveal fallback" },
  { id: "against", label: "Argue against this idea" },
] as const;

export type HowSectionId = (typeof HOW_SECTIONS)[number]["id"];
