import { ApprovalGuidePage } from "../../components/approval-guide-page.jsx";
import { APPROVAL_GUIDES } from "../../lib/approval-guides.js";

export default function GuidePage({ guide }) {
  return <ApprovalGuidePage guide={guide} />;
}

export function getStaticPaths() {
  return {
    paths: Object.values(APPROVAL_GUIDES).map(({ path }) => ({ params: { slug: path.split("/").pop() } })),
    fallback: false,
  };
}

export function getStaticProps({ params }) {
  const guide = APPROVAL_GUIDES[`/guides/${params.slug}`];
  return { props: { guide } };
}
