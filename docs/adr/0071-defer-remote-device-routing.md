# ADR-0071 — Device routing remoto diferido

- Estado: Aceptada

El dispositivo que recibe una instrucción podrá ser distinto del ejecutor, pero no habrá routing remoto en V0.6. No se introducen broker cloud, Android ni Raspberry Pi.

El diseño futuro distinguirá identidad de usuario, identidad de dispositivo, capacidades anunciadas y autoridad local. Cada dispositivo ejecutor conservará sus permisos y confirmaciones; una autorización remota nunca sustituirá controles locales. La comunicación requerirá autenticación mutua, protección contra replay, revocación y resultados inciertos explícitos.
