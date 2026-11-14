"use client";

import { useParams } from "next/navigation";
import { SaleNotFound } from "@/components/sale/sale-page";

/** The token page's 404 body: "No sale called <id>", with the id from the route. */
export function TokenNotFound() {
  const params = useParams<{ id?: string }>();
  const raw = params?.id ?? "";
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    /* not URL-encoded: show it as given */
  }
  return <SaleNotFound id={id} />;
}
