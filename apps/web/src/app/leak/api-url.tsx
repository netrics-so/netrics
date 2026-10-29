"use client";

// Throwaway (#160): proves the web build guard fails. Reverted.
const API_URL = process.env.NETRICS_API_URL ?? "";

export function ApiUrl() {
  return <p data-api={API_URL} />;
}
