# ADR-0066 — Browser Control como capacidad opcional

- Estado: Aceptada

Atlas Core conserva políticas, tareas, outcomes y confirmaciones de Browser Control. La ejecución ocurre mediante un adaptador del dispositivo Windows con Native Host y extensión Chrome. Chrome o el Bridge pueden estar ausentes sin impedir voz, memoria, Gmail, Calendar u otras integraciones.

Los permisos Chrome, Site ALLOW, grants, scope/document/epoch y confirmaciones del dispositivo ejecutor siguen siendo obligatorios. Un futuro router podrá elegir un dispositivo compatible, pero no podrá transferir ni saltarse autoridad local. Hito 0 no cambia Browser Control ni implementa routing remoto.
