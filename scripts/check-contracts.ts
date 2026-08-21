import { resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";

const specifications = [
  "packages/contracts/openapi.yaml",
  "packages/contracts/openapi-admin.yaml",
  "packages/contracts/openapi-worker.yaml",
];

for (const specification of specifications) {
  await SwaggerParser.validate(resolve(specification));
  console.log(JSON.stringify({ contract: specification, status: "valid" }));
}
