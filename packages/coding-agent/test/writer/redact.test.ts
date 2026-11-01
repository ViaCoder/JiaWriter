// Unit tests for src/writer/redact.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Function under test.
import { REDACTED, redactSecrets } from "../../src/writer/redact.ts";

describe("redactSecrets", () => {
	it("removes keys, bearer tokens, labelled values, URL credentials and long random strings", () => {
		// Known prefixes.
		expect(redactSecrets("key sk-test-0123456789abcdefABCDEF and ghp_0123456789abcdefghijABCD")).toBe(
			`key ${REDACTED} and ${REDACTED}`,
		);
		// Bearer and Authorization.
		expect(redactSecrets("Authorization: Bearer abc.def-ghi_123")).toBe(`Authorization: ${REDACTED}`);
		expect(redactSecrets("send Bearer abcdefgh12345678")).toBe(`send Bearer ${REDACTED}`);
		// Labelled values in English and Chinese.
		expect(redactSecrets("password=hunter2x token: abcd1234")).toBe(`password=${REDACTED} token: ${REDACTED}`);
		expect(redactSecrets("我的密码是 Qwe12345，密钥：k-998877。")).toBe(
			`我的密码是 ${REDACTED}，密钥：${REDACTED}。`,
		);
		// URL credentials and secret query parameters.
		expect(redactSecrets("见 https://user:pw@example.com/a?api_key=XYZ&x=1 。")).toBe(
			`见 https://example.com/a?api_key=${REDACTED}&x=1 。`,
		);
		// A long random string.
		expect(redactSecrets("id 3f9a8c7d6e5b4a3f2e1d0c9b8a7f6e5d4c3b")).toBe(`id ${REDACTED}`);
	});
	it("keeps ordinary text, numbers and plain URLs", () => {
		// Nothing secret.
		const plain = "字号用小二，行距 32 磅，见 https://www.gov.cn/zhengce/2026-10/31/content_1.htm 。";
		expect(redactSecrets(plain)).toBe(plain);
	});
});
