import Ajv, { type AnySchema } from 'ajv';

export interface SchemaValidationResult {
  valid: boolean;
  error?: string;
}

export function validateJsonOutputAgainstSchema(
  output: string,
  schema: unknown
): SchemaValidationResult {
  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(output);
  } catch (err) {
    return {
      valid: false,
      error: `The final output is not valid JSON: ${(err as Error).message}`,
    };
  }

  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema as AnySchema);
    if (validate(parsedOutput)) {
      return { valid: true };
    }

    return {
      valid: false,
      error: ajv.errorsText(validate.errors, { separator: '; ' }),
    };
  } catch (err) {
    return {
      valid: false,
      error: `The output schema could not be applied: ${(err as Error).message}`,
    };
  }
}

export function buildOutputSchemaCorrectionPrompt(
  schema: unknown,
  validationError?: string
): string {
  const errorSection = validationError
    ? `

Validation failure:
${validationError}`
    : '';
  const schemaSection = JSON.stringify(schema, null, 2);

  return `Your previous final output did not satisfy the required output contract.

You are running with an output JSON schema. Your next and final response MUST be one raw JSON value that conforms exactly to this JSON schema:

${schemaSection}

If the previous output was the intended output, then convert it to JSON conforming to the schema above. Otherwise, produce a fresh JSON value from the original task context and the schema above.

The JSON value must start with "{" and end with "}".${errorSection}`;
}

export function buildOutputSchemaConversionPrompt(options: {
  schema: unknown;
  failedOutput: string;
  validationError?: string;
}): string {
  const errorSection = options.validationError
    ? `

Validation failure from the previous attempt:
${options.validationError}`
    : '';
  const schemaSection = JSON.stringify(options.schema, null, 2);

  return `Convert the following failed model output into one raw JSON value that conforms exactly to the provided JSON schema.

Do not perform the original task again. Do not add new information. Preserve the substance of the failed output, but express it using the schema.
Do not output markdown, markdown fences, prose, comments, explanations, or any text outside the JSON value.
The JSON value must start with "{" and end with "}".

## JSON Schema
${schemaSection}${errorSection}

## Failed Output To Convert
${options.failedOutput}`;
}
