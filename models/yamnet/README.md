# Vendored: YAMNet

[YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
is Google's audio event classifier: a MobileNet v1 trained on AudioSet that
scores 521 classes from a 16 kHz mono waveform. These are the official
TensorFlow.js graph-model files, version 1, as published on TF Hub / Kaggle
Models (`google/yamnet/tfJs/tfjs/1`, fetched from
`https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1`):

- `model.json` — graph topology and weight manifest (input `waveform`,
  outputs: scores `[N, 521]`, embeddings `[N, 1024]`, log-mel spectrogram)
- `group1-shard1of4.bin` … `group1-shard4of4.bin` — weights, ~16 MB

`yamnet_class_map.csv` is the class index → AudioSet display name map from
`tensorflow/models` (`research/audioset/yamnet/yamnet_class_map.csv`).
`js/core/detect/yamnet-classes.js` is generated from it; regenerate that file
if this one ever changes.

Licence: Apache-2.0 (`LICENSE`). Nothing here is modified.
