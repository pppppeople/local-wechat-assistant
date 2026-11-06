# Verification scope

This repository contains source text, fictional tests, public documentation and empty configuration placeholders. It has no runtime snapshot, credentials, vendor archive, original Git history or preconfigured remote. The local initial commit is a fresh root commit.

`npm test` runs the exported suites in an isolated temporary HOME and temporary-data root, with inherited account/model credentials removed. HTTP, models, map results, notifications and media requests are mocked. Coverage includes classified record persistence/corruption, feature refusals and visibility, exact host account binding, duplicate messages, stable chunk identities and uncertain-operation recovery. Private-host integration assertions were excluded with the private host; their original behavior is not certified here.

`npm run check` checks every shipped JavaScript file's syntax before running tests. `npm run demo` demonstrates the default assistant with fictional inputs and a fake model. These checks do not establish live provider availability, account authorization, actual recipient delivery, model quality, background-service installation or deployment.

Project code uses Node.js built-in modules and has no external package dependency. Private local vendor packages were omitted, so this repository does not make a redistribution claim about them. The MIT license matches the project publication template; third-party services and any later dependencies retain their own terms.

Source/test text was screened for private identifiers, fixed home paths, credentials, account handles, contact data and cross-project imports. Examples containing identifiable place/itinerary labels were replaced with fictional data. Scan results support the prepared publication boundary; independent human review is still required before publication. The private export report and preparation scripts are kept outside this repository.
