# Original User Request

## 2026-08-11T20:44:01Z

# Teamwork Project Prompt — Draft

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Conduct a comprehensive, senior-level code audit of the entire codebase to identify existing bugs, potential future issues, and technical debt.

Working directory: c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction
Integrity mode: development

## Requirements

### R1. Full-Stack Comprehensive Audit
Thoroughly examine every file and folder across the entire stack (front-end, back-end, database, architecture). Identify existing bugs, architectural flaws, security risks, performance bottlenecks, and code smells. You may run external scripts, linters, or static analyzers to assist with this.

### R2. Detailed Issue Reporting
Generate a detailed, actionable report of all findings in a markdown artifact named `code_audit_report.md`, prioritized by severity and impact on future development velocity. You should only identify the issues and recommend fixes; do not make direct code changes to the project files.

## Acceptance Criteria

### Audit Report
- [ ] A comprehensive audit report named `code_audit_report.md` is generated.
- [ ] Issues are categorized by severity (Critical, High, Medium, Low, Technical Debt).
- [ ] Each issue includes the specific file path, line numbers, a description of the problem, and a recommended fix or refactoring strategy.
- [ ] The report includes a summary section detailing the tools, scripts, or methods used to conduct the audit.
- [ ] To ensure thoroughness, the audit must identify at least 10 substantive issues across different files. If fewer are found, the report must include a detailed justification of why the codebase is exceptionally clean.
