import { t } from './i18n';
import { api } from './api';

export const SUPPORTER_CONTACT_TYPES = ['WECHAT', 'QQ', 'EMAIL', 'OTHER'] as const;

export type SupporterContactType = (typeof SUPPORTER_CONTACT_TYPES)[number];
export type SupporterClaimStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export const SUPPORTER_CONTACT_LABELS: Record<SupporterContactType, string> = {
  WECHAT: t().claim.contactTypes.wechat,
  QQ: 'QQ',
  EMAIL: t().claim.contactTypes.email,
  OTHER: t().claim.contactTypes.other
};

export const SUPPORTER_CONSENT_TEXT =
  t().claim.consent;

export interface SupporterClaimInput {
  nickname: string;
  contactType: SupporterContactType;
  contactValue: string;
  amount: string;
  paidAt: string;
  message: string;
  consent: boolean;
}

export interface SupporterClaimState {
  claim_id: string;
  status: SupporterClaimStatus;
  nickname: string;
  created_at: string;
  reviewed_at: string | null;
}

export interface SupporterClaimResult {
  claim: SupporterClaimState | null;
  /** True when an open claim already existed, so nothing new was recorded. */
  duplicate: boolean;
}

/**
 * Client-side validation exists to give an immediate, specific message; the
 * server validates the same rules again and remains the authority.
 */
export function validateSupporterClaim(input: SupporterClaimInput): string | null {
  if (!input.nickname.trim()) return t().claim.nicknameRequired;
  if (!input.contactValue.trim()) return t().claim.contactRequired;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return t().claim.amountRequired;
  if (!input.paidAt.trim()) return t().claim.paidAtRequired;
  if (!input.consent) return t().claim.consentRequired;
  return null;
}

export async function submitSupporterClaim(
  input: SupporterClaimInput
): Promise<SupporterClaimResult> {
  return api<SupporterClaimResult>('/v1/supporter-claims', {
    method: 'POST',
    body: JSON.stringify({
      nickname: input.nickname.trim(),
      contact_type: input.contactType,
      contact_value: input.contactValue.trim(),
      amount: Number(input.amount),
      paid_at: input.paidAt,
      ...(input.message.trim() ? { message: input.message.trim() } : {}),
      consent: input.consent
    })
  });
}

export async function fetchMySupporterClaim(): Promise<SupporterClaimState | null> {
  const response = await api<{ claim: SupporterClaimState | null }>(
    '/v1/supporter-claims/me'
  );
  return response.claim;
}
