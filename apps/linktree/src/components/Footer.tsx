import Link from "next/link";

export default function Footer() {
  return (
    <div className="Footer container">
      <p>
        Made with{" "}
        <span role="img" aria-label="heart">
          ❤️
        </span>{" "}
        &nbsp; by &nbsp;{" "}
        <Link href={"https://github.com/jonaylor89/jonaylor.com"}>
          Johannes
        </Link>
      </p>
    </div>
  );
}
