<!--
Notas para Claude (borra este bloque antes de entregarlo):
- Dos entregables: PARTE 1 (correo breve, máximo 15 líneas) y PARTE 2 (anexo técnico). Se envían ambos, o el correo con el anexo adjunto.
- Completa cada {{MARCADOR}}. Si no se conoce, escribe "Por confirmar". Nunca inventes nombres, correos, IDs ni montos.
- Elimina lo que no aplique: bloques [WORKSPACE] salvo que el usuario mencione Google Workspace/Gmail; [DOMINIO] en un piloto con *.web.app;
  [STAGING] si solo habrá producción; [TI-DESPLIEGA] / [USUARIO-DESPLIEGA] según quién despliegue (references/planning.md §3).
- Nunca pongas precios, totales ni montos. Mantén la fórmula, los factores de costo y los enlaces oficiales.
- Vocabulario del producto: "incidencias" (no "observaciones") y "plano" (no "lámina").
- Sin secretos: este documento se envía por correo.
-->

# PARTE 1. Correo breve

**Asunto:** Solicitud: proyecto de Google Cloud/Firebase para alojar FreeField ({{piloto para ~N usuarios / despliegue para la empresa}})

Hola, {{CONTACTO_TI}}:

Queremos usar **FreeField**, una aplicación web de código abierto (MIT) que reúne modelos IFC, planos PDF e incidencias de obra, para {{EQUIPO}} (~{{N_USUARIOS}} usuarios). No es un servicio de un proveedor: cada empresa la ejecuta en **su propio proyecto de Google Cloud/Firebase**, así los datos, los usuarios y la facturación quedan con nosotros.

Lo que necesitamos (el detalle va en el anexo):
1. Un proyecto de Firebase (`{{ID_PROYECTO_SUGERIDO}}`) con un responsable{{[STAGING] ", más uno de pruebas (staging)"}}.
2. Facturación vinculada (plan Blaze, pago por uso) y una alerta de presupuesto mensual.
3. La región de los datos: proponemos {{REGIÓN}}. Es permanente.
4. Acceso para {{DESPLEGADOR}}: Propietario o Firebase Admin en el proyecto. {{[TI-DESPLIEGA] "O que ustedes lo desplieguen con los pasos adjuntos."}}
5. Que los filtros de correo dejen pasar el correo de inicio de sesión{{", y permitir los dominios indicados en el proxy"}}{{[DOMINIO] ", y los registros DNS de {{DOMINIO_PROPIO}}"}}.

Preguntas para ustedes: {{p. ej. ¿Ya tenemos una cuenta de facturación de Google Cloud? ¿Hay políticas que restrinjan regiones o funciones públicas? ¿Quién debe ser el dueño del proyecto?}}

El costo es por uso, con cuotas gratuitas; en el anexo van la fórmula y los enlaces de precios oficiales. ¡Gracias!
{{NOMBRE_SOLICITANTE}}, {{CARGO}}

---

# PARTE 2. Anexo técnico

**De:** {{NOMBRE_SOLICITANTE}}, {{CARGO}}, {{ÁREA}} · **Fecha:** {{FECHA}} · **Alcance:** {{ALCANCE}} · **Fecha deseada:** {{FECHA_OBJETIVO}}
**Código fuente (público, MIT):** {{URL_REPO, p. ej. https://github.com/theagentmarvin/free-field-app o nuestro fork}}

## 1. Resumen

FreeField es una aplicación web para el trabajo en terreno: modelos 3D IFC, planos PDF e incidencias de obra. Funciona en el navegador; no hay que instalar nada en los equipos de los usuarios. Cada empresa la aloja en su propio proyecto de Firebase. Uso esperado: ~{{N_USUARIOS}} usuarios y {{N_PROYECTOS}} proyectos/edificios activos, desde el {{FECHA_INICIO}}.

## 2. Lista de lo solicitado

- [ ] **Requisitos previos:** una organización de Google Cloud (o un lugar aprobado para el proyecto) y una **cuenta de facturación de Cloud**. Si nunca hemos usado Google Cloud, esto va primero.
- [ ] **Proyecto:** `{{ID_PROYECTO}}` (nuevo, o agregando Firebase a un proyecto de Google Cloud existente), con {{DUEÑO_PROYECTO}} como responsable.
  - [STAGING] Un segundo proyecto, `{{ID_PROYECTO}}-staging`, para probar las actualizaciones. Si no, operamos solo producción: es aceptable para un piloto, con respaldos y un plan de reversión (sección 10).
- [ ] **Facturación:** vincular el proyecto a la cuenta de facturación (plan **Blaze** de Firebase). Sin esto, Cloud Functions no funciona y nadie puede iniciar sesión en la app. Lo vincula finanzas (requiere *Billing Account User* en la cuenta).
- [ ] **Alerta de presupuesto:** {{MONTO, definido por TI/finanzas}} al mes, con avisos al 50/90/100 % a {{CORREOS_ALERTA}}. *La alerta avisa, pero no detiene el gasto.*
- [ ] **Región:** {{REGIÓN}} para la base de datos y los archivos (sección 5).
- [ ] **Accesos** para {{NOMBRE_CORREO_DESPLEGADOR}} (sección 4), *o* que TI despliegue (sección 9).
- [ ] **Productos** habilitados (sección 3).
- [ ] **Correo:** entrega de los correos de inicio de sesión (sección 6).
- [ ] **Red:** dominios permitidos en proxy/firewall, si filtramos el tráfico (sección 8).
- [ ] [DOMINIO] **Dominio propio** `{{DOMINIO_PROPIO}}` (sección 7). Sin él, la app funciona en `https://{{ID_PROYECTO}}.web.app`.

## 3. Productos y para qué se usan

| Producto | Para qué | Notas |
|---|---|---|
| Firebase Authentication, **enlace por correo (sin contraseña)** | Entrar con un enlace de un solo uso enviado al correo laboral | No se guardan contraseñas; no se habilita ningún otro proveedor |
| Cloud Firestore (modo producción) | Datos compartidos: proyectos, miembros, roles, invitaciones, incidencias, comentarios, y los metadatos de edificios/planos que un administrador publique | Reglas de seguridad versionadas en el código (`packages/ff-firestore/firestore.rules`) |
| Cloud Storage para Firebase (bucket por defecto) | Fotos de las incidencias, y los modelos convertidos (.frag) y planos PDF de los edificios que un administrador publique al equipo | Reglas en `storage.rules`: los miembros leen; los archivos son inmutables; los clientes no pueden borrar |
| Cloud Functions (2.ª generación) | Acciones de servidor: primer administrador, invitaciones, cambio de rol, baja de miembros, creación de proyectos | Node.js; se despliegan en **us-central1** (el código no fija otra región; ver sección 5) |
| Firebase Hosting | Sirve la aplicación web por HTTPS | CSP, HSTS y X-Frame-Options definidos en `firebase.json` |
| Secret Manager | Un secreto de servidor aleatorio (`BOOTSTRAP_SECRET`), usado solo para crear el primer administrador | Nunca sale de Google Cloud |

APIs que se habilitan al desplegar (TI puede habilitarlas antes, si quien despliega no tiene permiso): `firebase`, `identitytoolkit`, `securetoken`, `firestore`, `firebaserules`, `firebasestorage`, `storage`, `firebasehosting`, `cloudfunctions`, `run`, `cloudbuild`, `artifactregistry`, `eventarc`, `pubsub`, `secretmanager` (todas `*.googleapis.com`). Opcional: `billingbudgets`.

## 4. Accesos (IAM) de quien despliega

Quien despliega usa la herramienta oficial de Firebase (`firebase-tools`), tras iniciar sesión en el navegador (`firebase login`). **No se necesitan claves de cuentas de servicio.**

- **Lo más simple:** *Propietario (Owner)*, solo en el/los proyecto(s) de FreeField, durante la puesta en marcha. Se reduce después.
- **Mínimo privilegio** (confirmar con la documentación vigente de Google): *Firebase Admin* (`roles/firebase.admin`), *Cloud Functions Admin* (`roles/cloudfunctions.admin`), *Service Account User* (`roles/iam.serviceAccountUser`), *Secret Manager Admin* (`roles/secretmanager.admin`) y *Service Usage Admin* (`roles/serviceusage.serviceUsageAdmin`, si habilita APIs).
- **Por qué *Editor* no basta:** Editor no puede otorgar roles, vincular la facturación, cambiar políticas de organización ni dejar invocables públicamente las funciones (el despliegue les asigna una política IAM).
- **Vincular la facturación:** lo hace finanzas, con *Billing Account User* en la cuenta de facturación (más *Project Billing Manager* u Owner en el proyecto). Quien despliega no necesita permisos de facturación.
- Documentación: https://firebase.google.com/docs/projects/iam/roles-predefined-product · https://cloud.google.com/functions/docs/reference/iam/roles

**Políticas de organización a revisar:**
- *Uso compartido restringido por dominio* (`constraints/iam.allowedPolicyMemberDomains`): las funciones invocables deben permitir `allUsers` como invocador. Ellas mismas verifican la sesión y el rol del usuario. Este proyecto necesita una excepción; si no, responden 403.
- *Ubicaciones de recursos* (`constraints/gcp.resourceLocations`): permitir {{REGIÓN}} **y** `us-central1`.
- *Deshabilitar la creación de claves de cuentas de servicio*: no afecta, no usamos claves.

## 5. Región y residencia de datos

- **Firestore** y el **bucket de Storage**: {{REGIÓN}}. **La elección es permanente.** En Latinoamérica hay, entre otras, `southamerica-west1` (Santiago) y `southamerica-east1` (São Paulo). Hay que confirmar la disponibilidad con `firebase firestore:locations --project {{ID_PROYECTO}}` o en https://firebase.google.com/docs/firestore/locations, y en el selector de la Consola.
- **Cloud Functions corren hoy en `us-central1` (EE. UU.).** El código no fija una región, así que las acciones de servidor (invitaciones, cambios de rol, cierre del inicio de sesión) procesan datos en EE. UU. aunque la base de datos esté en otra región. {{Si la residencia exige procesar en la región: "Esto debe cambiarse en el código antes de salir a producción. Les pedimos confirmar si es un requisito."}}
- **Hosting:** CDN global de Google, solo archivos estáticos. **Authentication:** servicio global de Firebase (https://firebase.google.com/support/privacy).
- Los modelos, planos y calibraciones quedan en el navegador de cada usuario, **salvo que un administrador publique un edificio**. En ese caso, el modelo convertido y los planos PDF van al bucket indicado arriba. El archivo IFC original no se sube.

## 6. Correo de inicio de sesión

- Firebase envía el enlace de un solo uso desde **`noreply@{{ID_PROYECTO}}.firebaseapp.com`**. Les pedimos que los filtros no lo pongan en cuarentena.
- Los escáneres que abren los enlaces por adelantado pueden **consumir el enlace de un solo uso** antes de que el usuario haga clic. Les pedimos exceptuar `https://{{ID_PROYECTO}}.firebaseapp.com/__/auth/action`.
- Opcional: enviar desde nuestro propio dominio (Consola de Firebase → Authentication → Plantillas → personalizar dominio; Firebase indica los registros DNS).
- Límites diarios de envío: https://firebase.google.com/docs/auth/limits
- FreeField no envía las invitaciones por correo: un administrador copia el enlace de invitación y lo envía.
- [WORKSPACE] En la consola de administración de Google: permitir el remitente indicado (p. ej. una lista de remitentes aprobados o una regla para omitir el filtro de spam, en Gmail → Spam, phishing y software malicioso). Si la protección de enlaces o el análisis previo a la entrega reescribe o abre los enlaces, exceptuar la URL indicada. Los usuarios entran con su correo actual de Workspace; no hace falta ningún otro cambio en Workspace.

## 7. [DOMINIO] Dominio propio

Dirección: `{{DOMINIO_PROPIO}}`.
1. Lo agregamos en Firebase Hosting. La Consola muestra entonces los registros **TXT** (verificación de propiedad) y **A** exactos. **Les pedimos crearlos tal como aparecen** y eliminar los registros A/AAAA/CNAME que entren en conflicto con ese nombre.
2. El certificado TLS es automático (de minutos a unas 24 h).
3. Agregamos el dominio en Authentication → Dominios autorizados y en la configuración de la app.
4. El registro del dominio lo cobra nuestro **registrador**, no Firebase. Un subdominio de un dominio que ya tenemos no tiene costo extra.

## 8. Lista de permitidos en proxy / firewall (solo si se filtra el tráfico de salida)

**Navegadores de los usuarios**, HTTPS 443: {{[DOMINIO] `{{DOMINIO_PROPIO}}`,}} `{{ID_PROYECTO}}.web.app`, `{{ID_PROYECTO}}.firebaseapp.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `firestore.googleapis.com` (streaming de larga duración: por favor no cortarlo ni almacenarlo en búfer), `firebasestorage.googleapis.com`, `us-central1-{{ID_PROYECTO}}.cloudfunctions.net`, `*.run.app`. Opcional, solo si se activa el reporte de errores (desactivado por defecto): `*.ingest.sentry.io`.

**El computador de quien despliega** necesita además: `registry.npmjs.org`, `github.com`, `accounts.google.com`, `oauth2.googleapis.com`, `*.googleapis.com`, `storage.googleapis.com`.

## 9. Quién despliega

- [USUARIO-DESPLIEGA] {{NOMBRE_DESPLEGADOR}} despliega con la herramienta oficial, usando los accesos de la sección 4. TI conserva la propiedad y la facturación.
- [TI-DESPLIEGA] TI despliega. El archivo adjunto **deploy-steps.md** trae los comandos exactos, su orden y la solución de problemas. Desde el negocio entregamos la dirección del sitio (`APP_ORIGIN`) y el correo del primer administrador (`BOOTSTRAP_ADMIN_EMAILS` = {{CORREO_PRIMER_ADMIN}}). Una vez en línea, {{NOMBRE_SOLICITANTE}} hace el primer inicio de sesión como administrador e invita a los usuarios.

## 10. Notas para la revisión de seguridad

- **Código abierto (MIT):** el código, las reglas de seguridad y las funciones de servidor son públicos y revisables.
- **Local primero:** los modelos, planos y calibraciones se procesan en el navegador. A nuestro proyecto solo llegan proyectos, miembros, roles, invitaciones, incidencias con sus fotos y los edificios que se publiquen explícitamente.
- **Control de acceso en el servidor:** las reglas de Firestore y Storage verifican la membresía y el rol (admin/miembro) en cada solicitud. Al quitar a un miembro, pierde el acceso de inmediato. Las reglas se prueban contra el emulador de Firebase en la integración continua.
- **Sin contraseñas:** solo inicio de sesión por enlace. El primer administrador se crea una sola vez, desde un correo autorizado.
- **Sin rastreadores ni publicidad de terceros.** El reporte de errores es opcional y está desactivado por defecto.
- **Hosting endurecido** (CSP, HSTS, X-Frame-Options DENY, nosniff, Permissions-Policy). La clave web pública se restringirá a nuestros dominios y a las APIs necesarias.
- **Aislamiento:** cada compilación queda fijada a nuestro ID de proyecto y no arranca contra otro.
- **Resiliencia:** reversión del sitio con un clic y respaldos programados de Firestore (los activaremos). [Si solo hay producción: las actualizaciones se prueban localmente y se despliegan fuera del horario laboral.]
- **Soporte:** código abierto comunitario, **sin SLA de proveedor**. Infraestructura: Google Cloud (https://status.firebase.google.com).

## 11. Costo: cómo estimarlo

Pago por uso en nuestra propia cuenta de facturación. **Cada producto incluye una cuota gratuita mensual.** Un equipo pequeño suele quedar dentro o cerca de ella, pero les pedimos estimarlo con la calculadora oficial, no con cifras de este documento.

**Costo mensual ≈** Firestore (lecturas + escrituras + borrados de documentos + GiB almacenados) + Cloud Storage (GB almacenados + GB descargados + operaciones) + Cloud Functions (invocaciones + cómputo + datos salientes) + Hosting (GB almacenados y transferidos) + Artifact Registry (imágenes de compilación de las funciones) + Secret Manager (versiones de secretos + accesos) + respaldos si se activan, **menos la cuota gratuita de cada producto**. [DOMINIO] Más el cobro del registrador del dominio, fuera de Google.

**Qué lo mueve, aproximadamente en este orden:**
1. **Fotos y modelos/planos publicados:** espacio en Storage y, sobre todo, descargas (cada persona que abre un archivo lo descarga).
2. **Incidencias:** las lecturas y escrituras de Firestore crecen con los usuarios activos y el volumen de incidencias.
3. Functions, Hosting, Artifact Registry y Secret Manager: normalmente poco.

Precios oficiales: https://firebase.google.com/pricing · https://cloud.google.com/firestore/pricing · https://cloud.google.com/storage/pricing · https://cloud.google.com/functions/pricing · https://cloud.google.com/run/pricing · https://cloud.google.com/artifact-registry/pricing · https://cloud.google.com/secret-manager/pricing · Calculadora: https://cloud.google.com/products/calculator

## 12. Lo que TI **no** necesita proveer

Servidores, máquinas virtuales, Kubernetes, bases de datos administradas por nosotros ni VPN. Licencias de software. Claves de cuentas de servicio, servidor SMTP ni relay de correo. Instalaciones en los equipos de los usuarios. Operación continua más allá de vigilar la facturación{{[USUARIO-DESPLIEGA] "; {{NOMBRE_DESPLEGADOR}} despliega las actualizaciones con los mismos comandos"}}.

## 13. Contactos

Responsable de negocio: {{RESPONSABLE_NEGOCIO}} · Quien despliega: {{NOMBRE_CORREO_DESPLEGADOR}} · Dudas: {{CORREO_SOLICITANTE}}
