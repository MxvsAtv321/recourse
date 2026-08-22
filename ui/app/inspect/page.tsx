import { redirect } from "next/navigation";

/**
 * INSPECT is no longer a separate surface. The page reads INSPECT, PROTECT,
 * ENFORCE top to bottom at the root, with no navigation between acts. This
 * redirect exists only so the URL that was published earlier still lands
 * somewhere correct.
 */
export default function InspectRedirect() {
  redirect("/");
}
