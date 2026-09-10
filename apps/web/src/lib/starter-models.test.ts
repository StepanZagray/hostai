import { expect, it } from "vite-plus/test";
import { starterModels } from "./starter-models";
import { downloadModelError } from "./model-downloads";

it("offers only distinct valid local tags linked to their exact upstream listing", () => {
  expect(new Set(starterModels.map((model) => model.tag)).size).toBe(starterModels.length);
  for (const model of starterModels) {
    expect(downloadModelError(model.tag)).toBeNull();
    const source = new URL(model.source);
    expect(source.origin).toBe("https://ollama.com");
    expect(source.pathname).toBe(`/library/${model.tag}`);
    expect(source.search).toBe("");
    expect(source.hash).toBe("");
  }
});
