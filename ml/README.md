# ml

Reserved for the gesture-recognition model work.

**This directory is empty on purpose.** No dataset has been collected, so no
model has been trained, so nothing is claimed about accuracy. There are
deliberately no metrics in this repository — not even placeholder ones — because
a number that is not measured gets remembered as if it were.

`apps/mobile/src/recognition/index.ts` ships an `UnimplementedRecogniser` whose
`recognise()` always returns `null` and whose `isAvailable` is `false`. That is
the honest state of recognition today.

## What belongs here, when it exists

```
ml/
├── datasets/          gitignored — captured sensor recordings
├── training/          training scripts
├── evaluation/        held-out evaluation + confusion matrices
├── export/            conversion to on-device format (TFLite / ONNX)
└── checkpoints/       gitignored — model weights
```

`datasets/` and `checkpoints/` are already in `.gitignore`; model binaries and
raw recordings do not belong in version control.

## One language at a time

Sign languages do not share a gesture dictionary. ISL, ASL and BSL are separate
vocabularies that may overlap in appearance and mean different things — a model
for one is not a model for another.

`apps/mobile/src/recognition/profiles.ts` therefore models each language as an
independent profile, each with its own `vocabularySize`, all currently `0` and
`planned`. Any future dataset, model and set of metrics must be scoped to a
single named language and must not be presented as general "sign language".

`docs/roadmap.md` places data collection and modelling in a later milestone.
