/**
 * The issue chooser config (.github/ISSUE_TEMPLATE/config.yml) is the only
 * thing steering a public "New issue" click: GitHub renders its contact links
 * and honors blank_issues_enabled, and a malformed file fails silently — the
 * chooser just loses its links. This suite pins the documented contract
 * (docs: issue #8581): blank issues off, every link absolute and on this
 * repository, and a security entry that routes reports to SECURITY.md instead
 * of a public issue. Reads repo files only; no network, no subprocesses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const TEMPLATE_DIR = `${ROOT}.github/ISSUE_TEMPLATE`;

interface ContactLink { name?: unknown; url?: unknown; about?: unknown }
interface IssueTemplateConfig {
  blank_issues_enabled?: unknown;
  contact_links?: unknown;
}

const config = parse(readFileSync(`${TEMPLATE_DIR}/config.yml`, 'utf8')) as IssueTemplateConfig;
const links = (Array.isArray(config.contact_links) ? config.contact_links : []) as ContactLink[];

describe('issue template chooser config', () => {
  it('disables blank issues so every report picks a template or a contact link', () => {
    expect(config.blank_issues_enabled).toBe(false);
  });

  it('ships at least one well-formed contact link', () => {
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(typeof link.name, 'contact link name').toBe('string');
      expect((link.name as string).length).toBeGreaterThan(0);
      expect(typeof link.url, `${String(link.name)} url`).toBe('string');
      expect(typeof link.about, `${String(link.name)} about`).toBe('string');
      expect((link.about as string).length).toBeGreaterThan(0);
    }
  });

  it('keeps every contact link on an absolute github.com/ashlrai/phantom URL', () => {
    for (const link of links) {
      const url = link.url as string;
      expect(url, `${String(link.name)} must be an absolute URL`).toMatch(/^https:\/\//);
      expect(new URL(url).host, `${String(link.name)} must stay on github.com`).toBe('github.com');
      expect(url, `${String(link.name)} must point into this repository`).toContain('/ashlrai/phantom/');
      // Contact links never carry credentials or tokens.
      expect(url).not.toMatch(/token|secret|password|:[^/@\s]+@/i);
    }
  });

  it('routes vulnerability reports to SECURITY.md, not a public issue', () => {
    const security = links.find(link => /security|vulnerab/i.test(String(link.name)));
    expect(security, 'a security contact link must exist').toBeDefined();
    expect(String(security!.url)).toContain('/ashlrai/phantom/blob/master/SECURITY.md');
    expect(String(security!.about)).toMatch(/private/i);
  });

  it('points contributors at the starter-issue searches the labels already have', () => {
    const urls = links.map(link => String(link.url));
    expect(urls.some(url => url.includes('label%3A%22good%20first%20issue%22') || url.includes('label%3A%22good+first+issue%22'))).toBe(true);
  });

  it('leaves the directory templates the chooser offers in place', () => {
    for (const name of ['bug_report.md', 'feature_request.md', 'good_first_issue.md']) {
      expect(existsSync(`${TEMPLATE_DIR}/${name}`), `${name} must exist for the chooser`).toBe(true);
    }
  });
});
