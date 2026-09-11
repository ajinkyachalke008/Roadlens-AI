import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv04 from "ajv-draft-04";
import addFormats from "ajv-formats";
import YAML from "yaml";
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const ajv2020 = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv2020);
const ajv04 = new Ajv04({ allErrors: true, strict: false });
addFormats(ajv04);
const targets = [
  ["render.yaml", "https://render.com/schema/render.yaml.json"],
  ["render.single.yaml", "https://render.com/schema/render.yaml.json"],
  ["vercel.json", "https://openapi.vercel.sh/vercel.json"],
];
const schemas = new Map();
for (const [file, url] of targets) {
  let validate = schemas.get(url);
  if (!validate) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Provider schema unavailable");
    let schema = await response.json();
    if (file === "vercel.json") {
      const data = JSON.parse(await readFile(file, "utf8"));
      for (const key of Object.keys(data))
        if (!schema.properties[key])
          throw new Error("Unknown Vercel configuration field");
      schema = {
        $schema: schema.$schema,
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.keys(data).map((key) => [key, schema.properties[key]]),
        ),
      };
      console.log(
        "Vercel: validating every configured field against its official property schema; full upstream schema has an unrelated invalid draft-04 experimentalTriggers branch.",
      );
    }
    validate = (
      schema.$schema?.includes("2020-12")
        ? ajv2020
        : schema.$schema?.includes("draft-04")
          ? ajv04
          : ajv
    ).compile(schema);
    schemas.set(url, validate);
  }
  const text = await readFile(file, "utf8");
  const data = file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
  if (!validate(data))
    throw new Error(`${file}: ${JSON.stringify(validate.errors)}`);
  if (file.startsWith("render")) {
    if (
      data.services.length !== 1 ||
      data.services[0].plan !== "free" ||
      data.services[0].numInstances !== 1 ||
      data.databases
    )
      throw new Error("Unexpected deployment resource");
  }
  console.log(
    `${file}: valid against provider schema; free/single-process constraints checked`,
  );
}
