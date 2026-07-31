// The tunable parts of the pipeline (docs/12 §12.4), passed to the handlers as plain values: the
// application layer stays framework-free and never reads configuration itself.
export type ProcessingSettings = {
  previewMaxDim: number;
  thumbMaxDim: number;
};
