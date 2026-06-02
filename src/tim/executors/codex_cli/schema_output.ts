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
  previousOutput: string,
  validationError?: string
): string {
  const errorSection = validationError
    ? `

Validation failure:
${validationError}`
    : '';

  return `Your previous final output did not satisfy the required output contract.

You are running with an output JSON schema. Your next and final response MUST be raw valid JSON that conforms to the provided JSON schema.

Do not output markdown, markdown fences, prose, comments, explanations, or any text outside the JSON value. Markdown is unacceptable as the final output.
${errorSection}

Previous invalid final output:
${previousOutput}`;
}
