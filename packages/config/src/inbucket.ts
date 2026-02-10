import dedent from "dedent";
import { s } from "jsonv-ts";

const links = [
  {
    name: "Inbucket documentation",
    link: "https://www.inbucket.org",
  },
];

const tags = ["local"];

export const inbucket = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the local InBucket service.",
      tags,
      links,
    }),
    port: s.number({
      default: 54324,
      description: dedent`
         Port to use for the email testing server web interface.

         Emails sent with the local dev setup are not actually sent - rather, they are monitored, and you can view the emails that would have been sent from the web interface.
      `,
      tags,
      links,
    }),
    smtp_port: s.number({
      default: 54325,
      description: dedent`
         Port to use for the email testing server SMTP port.

         Emails sent with the local dev setup are not actually sent - rather, they are monitored, and you can view the emails that would have been sent from the web interface.

         If set, you can access the SMTP server from this port.
      `,
      tags,
      links,
    }),
    pop3_port: s.number({
      default: 54326,
      description: dedent`
         Port to use for the email testing server POP3 port.

         Emails sent with the local dev setup are not actually sent - rather, they are monitored, and you can view the emails that would have been sent from the web interface.

         If set, you can access the POP3 server from this port.
      `,
      tags,
      links,
    }),
  })
  .partial();
