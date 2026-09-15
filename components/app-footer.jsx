import Link from "next/link";

export function AppFooter() {
  return <footer className="app-footer">
    <span>Media Toolbox · Private media utilities</span>
    <nav aria-label="Legal and site links">
      <Link href="/privacy">Privacy Policy</Link>
      <Link href="/terms">Terms and Conditions</Link>
      <a href="/sitemap.xml">Sitemap</a>
    </nav>
  </footer>;
}
