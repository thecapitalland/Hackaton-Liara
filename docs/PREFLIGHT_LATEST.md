# Live API preflight

2026-10-23T17:15:14.243Z

- list projects: 200; { projects: array(1) }
- account + plans: 200; { user: object, team: object, databaseVersions: object, defaultDatabaseVersions: object, featureFlags: array(31), plans: object }
- networks: 200; { networks: array(1) }
- project detail: agate-liara: 200; { project: object }
- disks: agate-liara: 200; { disks: array(0), mounts: array(0) }
- logs v2: agate-liara: 200; { data: array(9) }
- logs v1: agate-liara: 200; array(1) of { type: string, datetime: string, message: string }
- events: agate-liara: 200; { data: array(12) }
- metrics summary: agate-liara: 200; { cpuUsage: array(1), memoryUsage: array(1), disksUsage: array(0) }
- metrics cpu: agate-liara: 200; { end: number, result: array(1) }
- metrics memory: agate-liara: 200; { end: number, result: array(2) }
- domains: agate-liara: 200; { domains: array(0), total: number }
- releases: agate-liara: 200; { total: number, currentRelease: string, readyReleasesCount: number, releases: array(10), platform: string }
- all domains: 200; { domains: array(0), total: number }
- dns zones: 200; { status: string, data: array(0) }