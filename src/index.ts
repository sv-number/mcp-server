#!/usr/bin/env node
// SV Number MCP server: a phone number an agent can order, read a code from, and give back.
//
//   SVN_API_KEY=... npx sv-number-mcp
//
// The key is read from the environment and never leaves this process: no tool returns it,
// and no error message quotes it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ApiError, call, expect, json, pollSeconds } from "./api.js";
import { totp } from "./totp.js";

const server = new McpServer({ name: "sv-number", version: "1.0.0" });

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

server.tool(
  "list_services",
  "Services available in a country: service code, price, how many numbers are online, and the "
  + "share of codes that actually arrived for other users. Pick by that share, not by price alone.",
  {
    country: z.number().int().describe("Country id from list_countries"),
    search: z.string().optional().describe("Filter by service name, case-insensitive"),
  },
  async ({ country, search }) => {
    try {
      const services = await json<Array<{ id: string; name: string; price: number;
                                          quantity: number; deliverability?: string }>>(
        "getServicesAndCostWithStatistics", { country });
      const found = search
        ? services.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
        : services;
      return text(found.map((s) => ({
        service: s.id, name: s.name, price: s.price,
        online: s.quantity, deliveredPercent: s.deliverability ?? null,
      })));
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "order_number",
  "Order a private number for one service in one country. The number is held for 20 minutes "
  + "and belongs to this activation alone. Money is held now and charged when the code arrives.",
  {
    service: z.string().describe("Service code from list_services, for example tg"),
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
        if (reply === "STATUS_CANCEL") return text({ code: null, state: "cancelled" });
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
  "Ask for one more code on the same number, for a password reset or a re-send.",
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
