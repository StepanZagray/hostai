"""Unit tests for :class:`hostai.Interaction` (stdlib unittest, no network)."""

from __future__ import annotations

import copy
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

DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema"
DRAFT_07 = "http://json-schema.org/draft-07/schema#"


def make_interaction(**overrides):
    """Build the standard echo Interaction from deep copies, with overrides."""
    kwargs = {
        "instructions": INSTRUCTIONS,
        "input_schema": copy.deepcopy(INPUT_SCHEMA),
        "output_schema": copy.deepcopy(OUTPUT_SCHEMA),
        "examples": copy.deepcopy(EXAMPLES),
    }
    kwargs.update(overrides)
    return hostai.Interaction(**kwargs)


def string_root(description="A string", **extra):
    """A minimal root schema of type string (no properties needed)."""
    schema = {"type": "string", "description": description}
    schema.update(extra)
    return schema


class ValidInteractionTests(unittest.TestCase):
    def test_valid_interaction_builds(self):
        interaction = make_interaction()
        self.assertEqual(interaction.instructions, INSTRUCTIONS)
        self.assertEqual(interaction.input_schema, INPUT_SCHEMA)
        self.assertEqual(interaction.output_schema, OUTPUT_SCHEMA)
        self.assertEqual(interaction.examples, EXAMPLES)
        self.assertIn("Interaction(", repr(interaction))

    def test_properties_return_equal_but_not_identical_copies(self):
        interaction = make_interaction()
        first_in, second_in = interaction.input_schema, interaction.input_schema
        self.assertEqual(first_in, second_in)
        self.assertIsNot(first_in, second_in)
        first_out, second_out = interaction.output_schema, interaction.output_schema
        self.assertEqual(first_out, second_out)
        self.assertIsNot(first_out, second_out)
        first_ex, second_ex = interaction.examples, interaction.examples
        self.assertEqual(first_ex, second_ex)
        self.assertIsNot(first_ex, second_ex)

    def test_mutating_returned_copies_does_not_affect_interaction(self):
        interaction = make_interaction()
        schema = interaction.input_schema
        schema["properties"]["text"]["type"] = "integer"
        schema["extra"] = True
        self.assertEqual(interaction.input_schema, INPUT_SCHEMA)
        out = interaction.output_schema
        out.clear()
        self.assertEqual(interaction.output_schema, OUTPUT_SCHEMA)
        examples = interaction.examples
        examples.append({"description": "junk"})
        examples[0]["input"]["text"] = "changed"
        self.assertEqual(interaction.examples, EXAMPLES)

    def test_mutating_constructor_arguments_after_construction_has_no_effect(self):
        input_schema = copy.deepcopy(INPUT_SCHEMA)
        output_schema = copy.deepcopy(OUTPUT_SCHEMA)
        examples = copy.deepcopy(EXAMPLES)
        interaction = hostai.Interaction(INSTRUCTIONS, input_schema, output_schema, examples)
        input_schema["properties"]["text"]["type"] = "integer"
        input_schema["required"] = []
        output_schema["description"] = "changed"
        examples[0]["input"]["text"] = "changed"
        examples.append({"description": "junk"})
        self.assertEqual(interaction.input_schema, INPUT_SCHEMA)
        self.assertEqual(interaction.output_schema, OUTPUT_SCHEMA)
        self.assertEqual(interaction.examples, EXAMPLES)
        # The validators were compiled from the original schema too.
        self.assertIsNotNone(interaction.input_error({"text": 5}))
        self.assertIsNotNone(interaction.input_error({}))


class InstructionsTests(unittest.TestCase):
    def test_instructions_not_a_string_rejected(self):
        for bad in (None, 42, b"bytes", ["list"]):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(instructions=bad)

    def test_instructions_blank_rejected(self):
        for bad in ("", "   ", "\n\t "):
            with self.subTest(bad=repr(bad)):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(instructions=bad)

    def test_instructions_too_long_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(instructions="x" * 16385)

    def test_instructions_at_limit_accepted(self):
        interaction = make_interaction(instructions="x" * 16384)
        self.assertEqual(len(interaction.instructions), 16384)


class RootSchemaTests(unittest.TestCase):
    def test_root_schema_not_a_dict_rejected(self):
        for bad in (True, False, [], ["type"], "string", None, 3):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(input_schema=bad)
                with self.assertRaises(hostai.ContractError):
                    make_interaction(output_schema=bad)

    def test_root_type_missing_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema={"description": "No type"})

    def test_root_type_list_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema={"type": ["string", "null"], "description": "Union"})

    def test_root_type_unknown_name_rejected(self):
        for bad in ("text", "int", "String", ""):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(input_schema={"type": bad, "description": "Unknown"})

    def test_root_description_missing_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema={"type": "string"})

    def test_root_description_blank_rejected(self):
        for bad in ("", "   ", "\n"):
            with self.subTest(bad=repr(bad)):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(input_schema=string_root(bad))

    def test_root_description_not_a_string_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=string_root(123))

    def test_root_description_too_long_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=string_root("d" * 4097))

    def test_root_description_at_limit_accepted(self):
        interaction = make_interaction(
            input_schema=string_root("d" * 4096),
            examples=[{"description": "Round trip", "input": "hi", "output": {"text": "hi"}}],
        )
        self.assertEqual(len(interaction.input_schema["description"]), 4096)

    def test_output_schema_is_validated_too(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(output_schema={"type": "object"})


class PropertyDescriptionTests(unittest.TestCase):
    def test_top_level_property_without_description_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "properties": {"text": {"type": "string"}},
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_property_with_blank_description_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "properties": {"text": {"type": "string", "description": "  "}},
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_nested_property_under_items_without_description_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "properties": {
                "rows": {
                    "type": "array",
                    "description": "Rows",
                    "items": {
                        "type": "object",
                        "properties": {"cell": {"type": "string"}},
                    },
                }
            },
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_nested_property_under_items_with_description_accepted(self):
        schema = {
            "type": "object",
            "description": "Request",
            "properties": {
                "rows": {
                    "type": "array",
                    "description": "Rows",
                    "items": {
                        "type": "object",
                        "properties": {"cell": {"type": "string", "description": "Cell"}},
                    },
                }
            },
        }
        interaction = make_interaction(
            input_schema=schema,
            examples=[
                {
                    "description": "Rows",
                    "input": {"rows": [{"cell": "a"}]},
                    "output": {"text": "a"},
                }
            ],
        )
        self.assertIsNone(interaction.input_error({"rows": [{"cell": "x"}]}))
        self.assertIsNotNone(interaction.input_error({"rows": [{"cell": 1}]}))

    def test_property_inside_defs_without_description_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "$defs": {
                "thing": {
                    "type": "object",
                    "properties": {"z": {"type": "string"}},
                }
            },
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_boolean_property_schema_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "properties": {"x": True},
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)


class InvalidJsonSchemaTests(unittest.TestCase):
    def test_minimum_not_a_number_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=string_root(minimum="abc"))

    def test_required_not_an_array_rejected(self):
        schema = {"type": "object", "description": "Request", "required": "x"}
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_schema_with_non_json_value_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=string_root(enum=[{1, 2}]))


class ReferenceTests(unittest.TestCase):
    def _object_with_ref(self, ref, defs=None, keyword="$ref"):
        schema = {
            "type": "object",
            "description": "Request",
            "properties": {"text": {"description": "Text", keyword: ref}},
            "required": ["text"],
        }
        if defs is not None:
            schema["$defs"] = defs
        return schema

    def test_remote_absolute_ref_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=self._object_with_ref("https://example.com/x.json#/a"))

    def test_remote_relative_ref_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=self._object_with_ref("other.json"))

    def test_ref_not_a_string_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=self._object_with_ref(["#/$defs/thing"]))

    def test_remote_dynamic_ref_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "$dynamicRef": "https://example.com/x.json#meta",
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_root_id_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=string_root(**{"$id": "https://example.com/root.json"}))

    def test_nested_id_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "$defs": {"thing": {"$id": "https://example.com/thing.json", "type": "string"}},
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_root_schema_keyword_draft_07_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=string_root(**{"$schema": DRAFT_07}))

    def test_root_schema_keyword_draft_2020_12_accepted(self):
        for uri in (DRAFT_2020_12, DRAFT_2020_12 + "#"):
            with self.subTest(uri=uri):
                schema = copy.deepcopy(INPUT_SCHEMA)
                schema["$schema"] = uri
                interaction = make_interaction(input_schema=schema)
                self.assertEqual(interaction.input_schema["$schema"], uri)

    def test_nested_schema_keyword_rejected(self):
        schema = {
            "type": "object",
            "description": "Request",
            "$defs": {"thing": {"$schema": DRAFT_2020_12, "type": "string"}},
        }
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_local_ref_to_existing_def_accepted_and_enforced(self):
        schema = self._object_with_ref("#/$defs/thing", defs={"thing": {"type": "string"}})
        interaction = make_interaction(input_schema=schema)
        self.assertIsNone(interaction.input_error({"text": "ok"}))
        self.assertIsNotNone(interaction.input_error({"text": 5}))

    def test_local_ref_to_missing_pointer_rejected(self):
        schema = self._object_with_ref("#/$defs/missing", defs={"thing": {"type": "string"}})
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)

    def test_local_anchor_ref_accepted(self):
        schema = self._object_with_ref(
            "#thing", defs={"thing": {"$anchor": "thing", "type": "string"}}
        )
        interaction = make_interaction(input_schema=schema)
        self.assertIsNone(interaction.input_error({"text": "ok"}))
        self.assertIsNotNone(interaction.input_error({"text": 5}))

    def test_local_anchor_ref_to_missing_anchor_rejected(self):
        schema = self._object_with_ref("#nowhere", defs={"thing": {"type": "string"}})
        with self.assertRaises(hostai.ContractError):
            make_interaction(input_schema=schema)


class ExamplesTests(unittest.TestCase):
    def _example(self, **overrides):
        example = copy.deepcopy(EXAMPLES[0])
        example.update(overrides)
        return example

    def test_examples_not_a_list_rejected(self):
        for bad in (None, "text", b"bytes", 5, {"description": "d"}, self._example()):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(examples=bad)

    def test_examples_empty_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[])

    def test_examples_nine_entries_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example() for _ in range(9)])

    def test_examples_eight_entries_accepted(self):
        interaction = make_interaction(examples=[self._example() for _ in range(8)])
        self.assertEqual(len(interaction.examples), 8)

    def test_examples_accept_tuple(self):
        interaction = make_interaction(examples=(self._example(),))
        self.assertEqual(interaction.examples, EXAMPLES)

    def test_example_entry_not_an_object_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=["not an object"])

    def test_example_missing_output_rejected(self):
        example = self._example()
        del example["output"]
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[example])

    def test_example_with_extra_key_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(note="extra")])

    def test_example_description_blank_rejected(self):
        for bad in ("", "  "):
            with self.subTest(bad=repr(bad)):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(examples=[self._example(description=bad)])

    def test_example_description_not_a_string_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(description=None)])

    def test_example_description_too_long_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(description="d" * 1025)])

    def test_example_description_at_limit_accepted(self):
        interaction = make_interaction(examples=[self._example(description="d" * 1024)])
        self.assertEqual(len(interaction.examples[0]["description"]), 1024)

    def test_example_input_not_conforming_rejected(self):
        for bad in ({"text": 5}, {}, {"text": "hi", "extra": 1}, "hi"):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(examples=[self._example(input=bad)])

    def test_example_output_not_conforming_rejected(self):
        for bad in ({"text": 5}, {}, None):
            with self.subTest(bad=bad):
                with self.assertRaises(hostai.ContractError):
                    make_interaction(examples=[self._example(output=bad)])

    def test_example_containing_nan_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(output={"text": float("nan")})])
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(input={"text": float("inf")})])

    def test_example_containing_non_json_value_rejected(self):
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(input={"text": {"a", "b"}})])
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(output={"text": b"bytes"})])
        with self.assertRaises(hostai.ContractError):
            make_interaction(examples=[self._example(input=object())])

    def test_example_null_input_accepted_for_null_schema(self):
        interaction = make_interaction(
            input_schema={"type": "null", "description": "Nothing in"},
            examples=[{"description": "Nothing", "input": None, "output": {"text": "hi"}}],
        )
        self.assertIsNone(interaction.examples[0]["input"])
        self.assertIn("input", interaction.examples[0])
        self.assertIsNone(interaction.input_error(None))
        self.assertIsNotNone(interaction.input_error({}))


class RuntimeCheckTests(unittest.TestCase):
    def test_input_error_none_for_valid_data(self):
        interaction = make_interaction()
        self.assertIsNone(interaction.input_error({"text": "anything"}))

    def test_input_error_message_for_invalid_data(self):
        interaction = make_interaction()
        for bad in ({"text": 5}, {}, {"text": "hi", "extra": 1}, [], None, "hi"):
            with self.subTest(bad=bad):
                problem = interaction.input_error(bad)
                self.assertIsInstance(problem, str)
                self.assertTrue(problem)

    def test_input_error_names_the_location(self):
        interaction = make_interaction()
        self.assertIn("/text", interaction.input_error({"text": 5}))
        self.assertIn("root", interaction.input_error("nope"))

    def test_output_error_none_for_valid_data(self):
        interaction = make_interaction()
        self.assertIsNone(interaction.output_error({"text": "reply"}))
        # output_schema has no additionalProperties: False
        self.assertIsNone(interaction.output_error({"text": "reply", "extra": 1}))

    def test_output_error_message_for_invalid_data(self):
        interaction = make_interaction()
        for bad in ({"text": 5}, {}, None, 7):
            with self.subTest(bad=bad):
                problem = interaction.output_error(bad)
                self.assertIsInstance(problem, str)
                self.assertTrue(problem)

    def test_to_manifest_has_exact_keys(self):
        manifest = make_interaction().to_manifest()
        self.assertEqual(set(manifest), {"instructions", "inputSchema", "outputSchema", "examples"})
        self.assertEqual(manifest["instructions"], INSTRUCTIONS)
        self.assertEqual(manifest["inputSchema"], INPUT_SCHEMA)
        self.assertEqual(manifest["outputSchema"], OUTPUT_SCHEMA)
        self.assertEqual(manifest["examples"], EXAMPLES)

    def test_to_manifest_is_a_fresh_copy_each_call(self):
        interaction = make_interaction()
        first = interaction.to_manifest()
        second = interaction.to_manifest()
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertIsNot(first["inputSchema"], second["inputSchema"])
        self.assertIsNot(first["examples"], second["examples"])
        first["inputSchema"]["type"] = "array"
        first["examples"].clear()
        del first["instructions"]
        third = interaction.to_manifest()
        self.assertEqual(third, second)


if __name__ == "__main__":
    unittest.main()
