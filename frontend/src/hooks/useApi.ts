import { fetchAuthSession } from 'aws-amplify/auth';
import { getConfig } from '../config';

function apiBase(): string {
  return getConfig().restApiUrl;
}

async function getToken(): Promise<string> {
  const { tokens } = await fetchAuthSession();
  return tokens?.idToken?.toString() ?? '';
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}
