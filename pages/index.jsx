export async function getServerSideProps() {
  return { redirect: { destination: "/image-converter", permanent: false } };
}

export default function HomePage() {
  return null;
}
