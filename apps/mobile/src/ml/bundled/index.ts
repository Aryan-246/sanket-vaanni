import publishedModelIsl from './published_model_isl.json';
import publishedModelAsl from './published_model_asl.json';

export const BUNDLED_MODELS: Readonly<Record<string, unknown>> = {
  isl: publishedModelIsl,
  asl: publishedModelAsl,
};
