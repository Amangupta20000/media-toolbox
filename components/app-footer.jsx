import Link from "next/link";
import { PRODUCT_NAME } from "../lib/site-metadata.js";

export function AppFooter() {
  return <footer className="app-footer">
    <div className="app-footer-main">
      <span>{PRODUCT_NAME} · Native-agent media utilities</span>
      <nav aria-label="Legal and site links">
        <Link href="/privacy" title="Privacy Policy">Privacy Policy</Link>
        <Link href="/terms" title="Terms and Conditions">Terms and Conditions</Link>
        <Link href="/contact" title="Contact Us">Contact Us</Link>
        <Link href="/offers" title="Local agent offers">Offers</Link>
        <a href="/sitemap.xml" title="Sitemap">Sitemap</a>
      </nav>
    </div>
    <div className="app-footer-copyright">© 2026 {PRODUCT_NAME}. All rights reserved.</div>
  </footer>;
}
