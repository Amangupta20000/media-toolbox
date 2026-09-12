export default function LicenseAdminPage() {
  return null;
}

export async function getServerSideProps() {
  return {
    redirect: {
      destination: "/admin",
      permanent: false,
    },
  };
}
