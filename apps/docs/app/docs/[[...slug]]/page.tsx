import { DocsPage, DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { notFound } from "next/navigation";
import { source } from "@/lib/source";
import type { Metadata } from "next";

export default function Page(props: { params: Promise<{ slug?: string[] }> }) {
  return props.params.then((params) => {
    const page = source.getPage(params.slug);
    if (!page) notFound();

    const MDX = page.data.body;

    return (
      <DocsPage toc={page.data.toc}>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <MDX components={{ ...defaultMdxComponents }} />
        </DocsBody>
      </DocsPage>
    );
  });
}

export function generateStaticParams() {
  return Promise.resolve(source.generateParams());
}

export function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  return props.params.then((params) => {
    const page = source.getPage(params.slug);
    if (!page) notFound();

    return {
      title: page.data.title,
      description: page.data.description,
    };
  });
}
