#!/usr/bin/env node
// SV Number MCP server: a phone number an agent can order, read a code from, and give back.
//
//   SVN_API_KEY=... npx sv-number-mcp
//
// The key is read from the environment and never leaves this process: no tool returns it,
// and no error message quotes it.

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ApiError, call, expect, json, pollSeconds } from "./api.js";
import { totp } from "./totp.js";

// Версия берётся из пакета, а не вписывается сюда: вписанная разошлась с package.json
// и сервер представлялся клиентам чужим номером версии.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const server = new McpServer({ name: "sv-number", version });

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failure = (error: unknown) => ({
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  isError: true,
});

server.tool(
  "get_balance",
  "Current account balance. Ordering a number needs a funded balance; there is no free tier.",
  {},
  async () => {
    try {
      // getBalance answers with a bare number, not with a marker
      const reply = await call("getBalance");
      const balance = Number(reply);
      if (Number.isNaN(balance)) throw new ApiError(reply.split(":")[0], reply);
      return text({ balance, currency: process.env.SVN_LANG === "ru" ? "RUB" : "USD" });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "list_countries",
  "Every country the numbers can come from, with its id and operators. Use the id in order_number.",
  { search: z.string().optional().describe("Filter by country name, case-insensitive") },
  async ({ search }) => {
    try {
      const countries = await json<Array<{ id: number; name: string; operators: Record<string, string> }>>(
        "getCountryAndOperators");
      const found = search
        ? countries.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
        : countries;
      return text(found.map((c) => ({ id: c.id, name: c.name, operators: Object.keys(c.operators) })));
    } catch (error) {
      return failure(error);
    }
  },
);

type Service = { id: string; name: string; price: number; quantity: number; deliverability?: string };

// The catalogue is written in site names, an agent usually holds a URL: "discord.com" has to
// find "Discord". Strip what the URL adds around the name and keep the raw query as well,
// because a few entries spell the domain out ("X.com (Twitter)").
const bareName = (query: string) =>
  query.toLowerCase().trim()
    .replace(/^[a-z]+:\/\//, "").replace(/^www\./, "")
    .replace(/\/.*$/, "").replace(/\.[a-z]{2,}$/, "");

// A short query lands inside unrelated names: "x" sits in the middle of "Maxim". Matching the
// whole word first keeps those below the site the agent actually asked for.
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (name: string, needle: string) =>
  needle.length > 0 && new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}([^a-z0-9]|$)`).test(name);

// Lower is better. Ranking matters because a short query matches dozens of names and the
// agent picks the first thing it reads.
const rank = (service: Service, query: string, bare: string) => {
  const id = service.id.toLowerCase();
  const name = service.name.toLowerCase();
  if (id === query || id === bare) return 0;
  if (name === query || name === bare) return 1;
  if (wholeWord(name, query)) return 2;
  if (wholeWord(name, bare)) return 3;
  if (name.includes(query)) return 4;
  if (name.startsWith(bare)) return 5;
  if (name.includes(bare)) return 6;
  return -1;
};

const view = (service: Service) => {
  // the API sends 0 where it has no statistics, which is not the same as "nothing arrives"
  const measured = Number(service.deliverability ?? 0);
  return { service: service.id, name: service.name, price: service.price,
           online: service.quantity, deliveredPercent: measured > 0 ? measured : null };
};

server.tool(
  "list_services",
  "Services available in a country, best match first. Order the code of the site you are "
  + "registering with: a number bought for one service does not receive another service's SMS. "
  + "Search by site name or domain, both work. The codes are arbitrary, so look them up instead "
  + "of guessing: uk is Airbnb, not the United Kingdom. deliveredPercent is null when the pair "
  + "has no statistics yet, which is the common case; then judge the pair by how many numbers "
  + "are online. When the site is not in the catalogue at all, order notInList (ot), which "
  + "receives SMS from any sender that is not in the list.",
  {
    country: z.number().int().describe("Country id from list_countries"),
    search: z.string().optional().describe("Site name or domain, for example discord or discord.com"),
  },
  async ({ country, search }) => {
    try {
      const services = await json<Service[]>("getServicesAndCostWithStatistics", { country });
      const fallback = services.find((s) => s.id === "ot");
      const query = search?.toLowerCase().trim() ?? "";
      if (!query) return text({ matches: services.map(view), notInList: fallback ? view(fallback) : null });

      // a query that is nothing but a suffix ("...com") strips down to an empty string, and an
      // empty needle matches every name in the catalogue
      const bare = bareName(query) || query;
      const found = services
        .map((s) => ({ s, r: rank(s, query, bare) }))
        .filter((hit) => hit.r >= 0)
        .sort((a, b) => a.r - b.r || b.s.quantity - a.s.quantity)
        .map((hit) => view(hit.s));

      return text({
        matches: found,
        notInList: fallback ? view(fallback) : null,
        note: found.length ? undefined
          : "Nothing here matches that name. The catalogue differs from country to country, so "
            + "try another country id before deciding the service is unavailable. If the site is "
            + "genuinely unlisted, order notInList (ot).",
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "order_number",
  "Order a private number for one service in one country. The number is held for 20 minutes "
  + "and belongs to this activation alone. Money is held now and charged when the code arrives. "
  + "The service code has to be the one for the site you are registering with, otherwise its SMS "
  + "goes to a different pool and never reaches you.",
  {
    service: z.string().describe("Service code from list_services, for example tg. It must belong "
      + "to the site you are registering with, or be ot when that site is not in the catalogue"),
    country: z.number().int().describe("Country id from list_countries"),
    operator: z.string().default("any").describe("Operator, or any to keep the pool wide"),
    maxPrice: z.number().optional().describe("Ceiling per activation; prices float with demand"),
  },
  async ({ service, country, operator, maxPrice }) => {
    try {
      const params: Record<string, string | number> = { service, country, operator };
      if (maxPrice !== undefined) params.maxPrice = maxPrice;
      const reply = await expect("ACCESS_NUMBER", "getNumber", params);
      const [, id, phone] = reply.split(":");
      return text({
        activationId: id, phone,
        note: "The phone has no leading +. Add it when the signup form wants E.164.",
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "wait_for_code",
  "Wait for the verification code on an ordered number. Polls on its own and returns the code "
  + "itself, already parsed out of the SMS. Trigger the SMS on the target service first.",
  {
    activationId: z.string().describe("Id returned by order_number"),
    timeoutSeconds: z.number().int().default(300).describe("How long to wait, up to the 20 minute life"),
  },
  async ({ activationId, timeoutSeconds }) => {
    const deadline = Date.now() + Math.min(timeoutSeconds, 20 * 60) * 1000;
    try {
      while (Date.now() < deadline) {
        const reply = await call("getStatus", { id: activationId });
        if (reply.startsWith("STATUS_OK")) return text({ code: reply.split(":")[1] });
        // the same answer covers a cancellation you made and the 20 minute expiry
        if (reply === "STATUS_CANCEL") return text({ code: null, state: "cancelled",
          next: "The activation is over and the money is back on the balance. Order a fresh "
              + "number instead of calling this id again." });
        if (!reply.startsWith("STATUS_")) throw new ApiError(reply.split(":")[0], reply);
        await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
      }
      return text({ code: null, state: "timeout",
                    next: "Call cancel_activation to get the money back, or wait again." });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "finish_activation",
  "Close an activation after the code was used. Do this on every success: a forgotten "
  + "activation holds money until it expires.",
  { activationId: z.string() },
  async ({ activationId }) => {
    try {
      await expect("ACCESS_ACTIVATION", "setStatus", { id: activationId, status: 6 });
      return text({ state: "finished" });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "cancel_activation",
  "Cancel an activation when no code arrived; the money returns to the balance in full. "
  + "Can be called right after ordering. If the API answers that it is too early, wait a "
  + "couple of minutes and repeat.",
  { activationId: z.string() },
  async ({ activationId }) => {
    try {
      await expect("ACCESS_CANCEL", "setStatus", { id: activationId, status: 8 });
      return text({ state: "cancelled", money: "returned to the balance" });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "request_another_sms",
  "Ask for one more code on the same number, for a password reset or a re-send. Works "
  + "only after a first code has already arrived; before that the API refuses it.",
  { activationId: z.string() },
  async ({ activationId }) => {
    try {
      await expect("ACCESS_RETRY_GET", "setStatus", { id: activationId, status: 3 });
      return text({ state: "waiting for another SMS" });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "totp_code",
  "Compute the authenticator code for an account whose second factor was set up with a shared "
  + "secret. Runs locally by RFC 6238: the secret never leaves this machine.",
  {
    secret: z.string().describe("Base32 secret shown when 2FA was enabled"),
    digits: z.number().int().default(6),
    period: z.number().int().default(30),
    algorithm: z.enum(["sha1", "sha256", "sha512"]).default("sha1"),
  },
  async ({ secret, digits, period, algorithm }) => {
    try {
      return text(totp(secret, { digits, period, algorithm }));
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());
