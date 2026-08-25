import { constants, createSign } from "node:crypto";

export type GongjiCredentials = Readonly<{
  token: string;
  privateKeyPem?: string;
}>;

export const gongjiSigningInput = (
  path: string,
  version: string,
  timestampMilliseconds: number,
  token: string,
  body: string,
): string => `${path}\n${version}\n${timestampMilliseconds}\n${token}\n${body}`;

export const signGongjiRequest = (
  input: Readonly<{
    path: string;
    version: string;
    timestampMilliseconds: number;
    token: string;
    body: string;
    privateKeyPem: string;
  }>,
): string => {
  const signer = createSign("RSA-SHA256");
  signer.update(
    gongjiSigningInput(input.path, input.version, input.timestampMilliseconds, input.token, input.body),
    "utf8",
  );
  signer.end();
  return signer.sign({ key: input.privateKeyPem, padding: constants.RSA_PKCS1_PADDING }, "base64");
};
