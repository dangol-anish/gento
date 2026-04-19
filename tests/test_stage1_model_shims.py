import unittest

from transformers import PretrainedConfig

from scripts.extractor.model import _ensure_generation_mixin, _patch_prepare_inputs_for_generation


class DummyLM:
    def __init__(self):
        self.config = PretrainedConfig()
        self.calls = []

    def prepare_inputs_for_generation(self, decoder_input_ids, past_key_values=None, **kwargs):
        self.calls.append(past_key_values)
        return {"past_key_values": past_key_values, "decoder_input_ids": decoder_input_ids}


class DummyWrapper:
    def __init__(self):
        self.config = PretrainedConfig()
        self.language_model = DummyLM()

    def prepare_inputs_for_generation(self, decoder_input_ids, past_key_values=None, **kwargs):
        return {"past_key_values": past_key_values, "decoder_input_ids": decoder_input_ids}


class TestStage1ModelShims(unittest.TestCase):
    def test_ensure_generation_mixin_adds_generate(self):
        model = DummyWrapper()
        self.assertFalse(hasattr(model.language_model, "generate"))
        _ensure_generation_mixin(model)
        self.assertTrue(hasattr(model.language_model, "generate"))

    def test_patch_prepare_inputs_for_generation_normalizes_empty_cache(self):
        model = DummyWrapper()
        _patch_prepare_inputs_for_generation(model)

        # empty-ish cache shape from some transformers versions: outer non-None with None inner entry
        model.language_model.prepare_inputs_for_generation(decoder_input_ids=[1], past_key_values=[[None]])
        self.assertEqual(model.language_model.calls[-1], None)

        # a non-empty cache should pass through untouched
        sentinel = object()
        model.language_model.prepare_inputs_for_generation(decoder_input_ids=[1], past_key_values=[[sentinel]])
        self.assertEqual(model.language_model.calls[-1], [[sentinel]])


if __name__ == "__main__":
    unittest.main()

