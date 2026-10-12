export const MASTER_TEST_ACCOUNT_EMAIL = "sanborn.li.hk@gmail.com";
// Temporary: the second address exists only for the 0.5.6 installation test.
// Remove it when that test is finished.
export const MASTER_TEST_ACCOUNT_EMAILS: readonly string[] = [
  MASTER_TEST_ACCOUNT_EMAIL,
  "lokiplaytesting@gmail.com",
];
export const DEPLOYMENT_CREDENTIAL_MONTHLY_QUOTA = 100;

export const isMasterTestAccount = (
  email: string | undefined | null,
): boolean => MASTER_TEST_ACCOUNT_EMAILS.includes((email ?? "").trim().toLowerCase());
