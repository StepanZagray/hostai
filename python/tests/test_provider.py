"""Unit tests for :class:`hostai.Model` and :class:`hostai.Provider`.

Stdlib unittest only; never opens a socket or touches the disk.
"""

from __future__ import annotations

import copy
import http.server
import json
import unittest

import hostai

INPUT_SCHEMA = {
    "type": "object",
    "description": "Echo request",
    "properties": {"text": {"type": "string", "description": "Text"}},
    "required": ["text"],
    "additionalProperties": False,
}
OUTPUT_SCHEMA = {
    "type": "object",
    "description": "Echo reply",
    "properties": {"text": {"type": "string", "description": "Text"}},
    "required": ["text"],
}
EXAMPLES = [{"description": "Round trip", "input": {"text": "hi"}, "output": {"text": "hi"}}]
INSTRUCTIONS = "Echo the text back."


def echo(data):
    return {"text": data["text"]}


def make_interaction(instructions=INSTRUCTIONS):
    return hostai.Interaction(
        instructions=instructions,
        input_schema=copy.deepcopy(INPUT_SCHEMA),
        output_schema=copy.deepcopy(OUTPUT_SCHEMA),
        examples=copy.deepcopy(EXAMPLES),
    )


def make_model(name="echo", infer=echo, interaction=None, **kwargs):
    if interaction is None:
        interaction = make_interaction()
    return hostai.Model(name, infer=infer, interaction=interaction, **kwargs)


def make_provider(runtime="echo", models=None, **kwargs):
    if models is None:
        models = [make_model()]
    return hostai.Provider(runtime=runtime, models=models, **kwargs)


class ModelTests(unittest.TestCase):
    def test_invalid_names_rejected(self):
        for bad in (
            "",
            "-abc",
            "a b",
            "a" * 129,
            5,
            None,
            b"echo",
            " echo",
            "_echo",
            "a\n",
            "org/model+beta",
            "remote:cloud",
            "remote-cloud",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_model(name=bad)

    def test_valid_names_accepted(self):
        for good in ("a", "0", "a" * 128, "echo-2", "org/model:v1.0-beta_x"):
            with self.subTest(good=good):
                self.assertEqual(make_model(name=good).name, good)

    def test_non_callable_infer_rejected(self):
        for bad in (None, "echo", 42, {"text": "hi"}):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_model(infer=bad)

    def test_interaction_not_an_interaction_rejected(self):
        for bad in (None, {}, make_interaction().to_manifest(), "contract"):
            with self.subTest(bad=type(bad).__name__):
                with self.assertRaises(hostai.ContractError):
                    hostai.Model("echo", infer=echo, interaction=bad)

    def test_invalid_size_bytes_rejected(self):
        for bad in (-1, True, False, 1.5, 0.0, "0", None, 2**63):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_model(size_bytes=bad)

    def test_valid_model_exposes_attributes(self):
        interaction = make_interaction()
        model = hostai.Model("echo", infer=echo, interaction=interaction, size_bytes=1234)
        self.assertEqual(model.name, "echo")
        self.assertEqual(model.size_bytes, 1234)
        self.assertIs(model.interaction, interaction)
        self.assertIs(model.infer, echo)
        self.assertEqual(model.infer({"text": "x"}), {"text": "x"})
        self.assertEqual(make_model().size_bytes, 0)
        self.assertIn("echo", repr(model))

    def test_to_manifest_shape(self):
        interaction = make_interaction()
        model = hostai.Model("echo", infer=echo, interaction=interaction, size_bytes=7)
        manifest = model.to_manifest()
        self.assertEqual(
            manifest,
            {
                "name": "echo",
                "sizeBytes": 7,
                "capabilities": {"chat": False, "infer": True},
                "interaction": interaction.to_manifest(),
                "parameterSize": "",
                "quantization": "",
                "modifiedAt": "",
            },
        )
        self.assertEqual(
            set(manifest["interaction"]),
            {"instructions", "inputSchema", "outputSchema", "examples"},
        )
        self.assertIsNot(model.to_manifest(), manifest)


class ProviderConstructionTests(unittest.TestCase):
    def test_runtime_rejected_by_regex(self):
        for bad in ("Echo", "a\n", "a_b", "a" * 33, "", "-a", "a b", "a.b", None, 7):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_provider(runtime=bad)

    def test_runtime_accepted_by_regex(self):
        for good in ("a", "1abc", "echo-2", "a" * 32, "a0", "z-"):
            with self.subTest(good=good):
                self.assertEqual(make_provider(runtime=good).runtime, good)

    def test_models_empty_rejected(self):
        for empty in ([], (), iter(())):
            with self.subTest(empty=type(empty).__name__):
                with self.assertRaises(hostai.ContractError):
                    make_provider(models=empty)

    def test_models_not_iterable_rejected(self):
        for bad in (None, 42, 3.5):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    hostai.Provider("echo", bad)

    def test_models_string_rejected(self):
        for bad in ("echo", b"echo"):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_provider(models=bad)

    def test_models_containing_non_model_rejected(self):
        for bad in ([make_model(), "echo"], [None], [make_interaction()], [{"name": "echo"}]):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_provider(models=bad)

    def test_bare_model_instead_of_list_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_provider(models=make_model())

    def test_duplicate_model_names_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_provider(models=[make_model("echo"), make_model("echo")])

    def test_models_accept_any_iterable(self):
        interaction = make_interaction()
        models = (
            make_model("a", interaction=interaction),
            make_model("b", interaction=interaction),
        )
        provider = make_provider(models=iter(models))
        self.assertEqual(provider.models, models)
        self.assertIs(provider.model("a"), models[0])
        self.assertIs(provider.model("b"), models[1])

    def test_ui_not_a_custom_ui_rejected(self):
        for bad in ("ui", object(), {"index.html": "<html>"}, 1):
            with self.subTest(bad=type(bad).__name__):
                with self.assertRaises(hostai.ContractError):
                    make_provider(ui=bad)

    def test_provider_without_ui_exposes_none(self):
        provider = make_provider()
        self.assertIsNone(provider.ui)
        self.assertEqual(provider.runtime, "echo")
        self.assertIsInstance(provider.models, tuple)
        self.assertEqual(len(provider.models), 1)
        self.assertIn("ui=False", repr(provider))


class ManifestTests(unittest.TestCase):
    def test_manifest_top_level_shape(self):
        model = make_model()
        provider = hostai.Provider(runtime="echo", models=[model])
        manifest = provider.manifest()
        self.assertEqual(
            manifest,
            {
                "protocol": 1,
                "runtime": "echo",
                "models": [model.to_manifest()],
                "ui": None,
            },
        )
        self.assertEqual(manifest["protocol"], hostai.PROTOCOL_VERSION)
        self.assertEqual(list(manifest), ["protocol", "runtime", "models", "ui"])

    def test_manifest_is_json_serializable(self):
        text = json.dumps(make_provider().manifest(), allow_nan=False)
        self.assertEqual(json.loads(text)["runtime"], "echo")

    def test_manifest_calls_return_equal_but_not_identical_objects(self):
        provider = make_provider()
        first = provider.manifest()
        second = provider.manifest()
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertIsNot(first["models"], second["models"])
        self.assertIsNot(first["models"][0], second["models"][0])
        self.assertIsNot(
            first["models"][0]["interaction"]["inputSchema"],
            second["models"][0]["interaction"]["inputSchema"],
        )

    def test_mutating_a_manifest_does_not_affect_the_next(self):
        provider = make_provider()
        reference = provider.manifest()
        victim = provider.manifest()
        victim["models"][0]["name"] = "zzz"
        victim["models"][0]["interaction"]["inputSchema"]["type"] = "array"
        victim["models"][0]["interaction"]["examples"].clear()
        victim["models"].append({"name": "junk"})
        victim["runtime"] = "other"
        victim["extra"] = True
        self.assertEqual(provider.manifest(), reference)
        self.assertEqual(provider.runtime, "echo")
        self.assertEqual(provider.model("echo").name, "echo")

    def test_manifest_bytes_is_compact_json(self):
        provider = make_provider()
        raw = provider.manifest_bytes()
        self.assertIsInstance(raw, bytes)
        self.assertEqual(json.loads(raw.decode("utf-8")), provider.manifest())
        expected = json.dumps(
            provider.manifest(), separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")
        self.assertEqual(raw, expected)
        self.assertNotIn(b"\n", raw)
        self.assertLessEqual(len(raw), hostai.MAX_MANIFEST_BYTES)

    def test_manifest_over_size_limit_rejected(self):
        self.assertEqual(hostai.MAX_MANIFEST_BYTES, 262_144)
        interaction = make_interaction(instructions="x" * 16384)
        models = [make_model(f"m{i}", interaction=interaction) for i in range(20)]
        with self.assertRaisesRegex(hostai.ContractError, r"limit is 262144"):
            hostai.Provider(runtime="echo", models=models)

    def test_manifest_under_size_limit_accepted(self):
        interaction = make_interaction(instructions="x" * 16384)
        models = [make_model(f"m{i}", interaction=interaction) for i in range(4)]
        provider = hostai.Provider(runtime="echo", models=models)
        self.assertLessEqual(len(provider.manifest_bytes()), hostai.MAX_MANIFEST_BYTES)
        self.assertEqual(len(provider.manifest()["models"]), 4)


class HeadlessUseTests(unittest.TestCase):
    def test_two_headless_calls_without_fetching_ui(self):
        provider = make_provider()
        self.assertIsNone(provider.ui)
        self.assertEqual(provider.infer("echo", {"text": "first"}), {"text": "first"})
        self.assertEqual(provider.infer("echo", {"text": "second"}), {"text": "second"})

    def test_asset_raises_asset_error_without_ui(self):
        provider = make_provider()
        with self.assertRaises(hostai.AssetError):
            provider.asset("index.html")
        with self.assertRaises(hostai.AssetError):
            provider.asset("")

    def test_asset_error_is_a_lookup_error(self):
        provider = make_provider()
        with self.assertRaises(LookupError):
            provider.asset("index.html")


class InferTests(unittest.TestCase):
    def test_non_string_keys_cannot_silently_collide_or_change_type(self):
        for bad in ({2024: "a", "2024": "b"}, {"nested": {1: "value"}}, {"items": [{False: 1}]}):
            provider = make_provider(models=[make_model(infer=lambda data, bad=bad: bad)])
            with self.subTest(bad=bad), self.assertRaises(hostai.OutputError):
                provider.infer("echo", {"text": "hi"})
            with self.assertRaises(hostai.InputError):
                provider.infer("echo", bad)

    def test_unknown_model_rejected(self):
        provider = make_provider()
        for bad in ("nope", "", "ECHO", None, 3):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.UnknownModelError):
                    provider.infer(bad, {"text": "hi"})
                with self.assertRaises(hostai.UnknownModelError):
                    provider.model(bad)

    def test_unknown_model_is_a_lookup_error(self):
        with self.assertRaises(LookupError):
            make_provider().infer("nope", {"text": "hi"})

    def test_non_conforming_input_rejected(self):
        provider = make_provider()
        for bad in ({"text": 5}, {}, {"text": "hi", "extra": 1}, "hi", None, ["text"]):
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(hostai.InputError, "input schema"):
                    provider.infer("echo", bad)

    def test_non_json_input_rejected(self):
        provider = make_provider()
        for bad in (set(), {"text": {"a"}}, {"text": b"hi"}, object(), {"text": float("nan")}):
            with self.subTest(bad=repr(bad)):
                with self.assertRaises(hostai.InputError):
                    provider.infer("echo", bad)

    def test_input_error_is_a_value_error(self):
        with self.assertRaises(ValueError):
            make_provider().infer("echo", {"text": 5})

    def test_callable_receives_a_copy_of_the_input(self):
        received = []

        def spy(data):
            received.append(data)
            data["text"] = "mutated inside"
            data["injected"] = True
            return {"text": "ok"}

        provider = make_provider(models=[make_model(infer=spy)])
        caller_input = {"text": "original"}
        self.assertEqual(provider.infer("echo", caller_input), {"text": "ok"})
        self.assertEqual(len(received), 1)
        self.assertIsNot(received[0], caller_input)
        self.assertEqual(caller_input, {"text": "original"})
        self.assertEqual(received[0], {"text": "mutated inside", "injected": True})

    def test_callable_receives_validated_json_data(self):
        received = []

        def spy(data):
            received.append(data)
            return {"text": data["text"]}

        provider = make_provider(models=[make_model(infer=spy)])
        provider.infer("echo", {"text": "hi"})
        self.assertEqual(received, [{"text": "hi"}])
        self.assertIsInstance(received[0], dict)

    def test_non_conforming_output_rejected(self):
        for bad in ({"text": 5}, {}, None, "hi", ["text"]):
            with self.subTest(bad=bad):
                provider = make_provider(models=[make_model(infer=lambda data, bad=bad: bad)])
                with self.assertRaisesRegex(hostai.OutputError, "output schema"):
                    provider.infer("echo", {"text": "hi"})

    def test_non_finite_output_rejected(self):
        for bad in (float("inf"), float("-inf"), float("nan")):
            with self.subTest(bad=bad):
                provider = make_provider(
                    models=[make_model(infer=lambda data, bad=bad: {"text": "hi", "n": bad})]
                )
                with self.assertRaises(hostai.OutputError):
                    provider.infer("echo", {"text": "hi"})

    def test_non_json_output_rejected(self):
        for bad in (object(), {"text": "hi", "blob": b"x"}, {"text": {"a"}}, {1, 2}):
            with self.subTest(bad=repr(bad)):
                provider = make_provider(models=[make_model(infer=lambda data, bad=bad: bad)])
                with self.assertRaises(hostai.OutputError):
                    provider.infer("echo", {"text": "hi"})

    def test_callable_raising_becomes_inference_error_with_cause(self):
        boom = RuntimeError("boom")

        def failing(data):
            raise boom

        provider = make_provider(models=[make_model(infer=failing)])
        with self.assertRaises(hostai.InferenceError) as ctx:
            provider.infer("echo", {"text": "hi"})
        self.assertIs(ctx.exception.__cause__, boom)
        self.assertIn("echo", str(ctx.exception))
        self.assertNotIn("boom", str(ctx.exception))

    def test_callable_can_explicitly_reject_domain_input(self):
        def failing(data):
            raise hostai.InputError("not the caller's fault")

        provider = make_provider(models=[make_model(infer=failing)])
        with self.assertRaises(hostai.InputError):
            provider.infer("echo", {"text": "hi"})

    def test_returned_output_is_a_fresh_copy(self):
        retained = {"text": "kept"}

        def keeper(data):
            return retained

        provider = make_provider(models=[make_model(infer=keeper)])
        result = provider.infer("echo", {"text": "hi"})
        self.assertEqual(result, {"text": "kept"})
        self.assertIsNot(result, retained)
        result["text"] = "changed"
        result["extra"] = 1
        self.assertEqual(retained, {"text": "kept"})
        self.assertEqual(provider.infer("echo", {"text": "hi"}), {"text": "kept"})

    def test_infer_dispatches_to_the_named_model(self):
        interaction = make_interaction()
        upper = make_model(
            "upper", infer=lambda d: {"text": d["text"].upper()}, interaction=interaction
        )
        lower = make_model(
            "lower", infer=lambda d: {"text": d["text"].lower()}, interaction=interaction
        )
        provider = make_provider(models=[upper, lower])
        self.assertEqual(provider.infer("upper", {"text": "Hi"}), {"text": "HI"})
        self.assertEqual(provider.infer("lower", {"text": "Hi"}), {"text": "hi"})

    def test_all_errors_derive_from_hostai_error(self):
        for cls in (
            hostai.ContractError,
            hostai.UnknownModelError,
            hostai.InputError,
            hostai.InferenceError,
            hostai.OutputError,
            hostai.AssetError,
        ):
            with self.subTest(cls=cls.__name__):
                self.assertTrue(issubclass(cls, hostai.HostAIError))


class HandlerTests(unittest.TestCase):
    def test_handler_returns_request_handler_subclass(self):
        provider = make_provider()
        handler_cls = provider.handler()
        self.assertIsInstance(handler_cls, type)
        self.assertTrue(issubclass(handler_cls, http.server.BaseHTTPRequestHandler))
        self.assertIsNot(handler_cls, http.server.BaseHTTPRequestHandler)

    def test_handler_is_bound_to_the_provider(self):
        provider = make_provider()
        handler_cls = provider.handler()
        self.assertIs(getattr(handler_cls, "hostai_provider", None), provider)
        other = make_provider(runtime="other")
        self.assertIsNot(other.handler(), handler_cls)


if __name__ == "__main__":
    unittest.main()
