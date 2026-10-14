# ADR-0070 — Distribución y actualizaciones

- Estado: Aceptada como política; implementación posterior

La primera distribución de V0.6.1 será un build local de desarrollo. Instalador, autostart y updater pertenecen a hitos posteriores. El inicio con Windows estará desactivado por defecto.

Las actualizaciones productivas deberán estar firmadas/verificadas, ser atómicas o recuperables y disponer de rollback. No se ejecutarán artefactos cuya integridad no pueda verificarse. Hito 0 no añade packaging, updater ni permisos del sistema.
