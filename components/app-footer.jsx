import Link from "next/link";

export function AppFooter() {
  return <footer className="app-footer">
    <span>Media Toolbox · Private media utilities</span>
    <nav aria-label="Legal and site links">
      <Link href="/privacy" title="Privacy Policy">Privacy Policy</Link>
      <Link href="/terms" title="Terms and Conditions">Terms and Conditions</Link>
      <a href="/sitemap.xml" title="Sitemap">Sitemap</a>
    </nav>
  </footer>;
}
