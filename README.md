# Zirkel G - Galería Grid

Galería de arte 3D interactiva con sistema de persistencia y exportación.

## Características

- Navegación 3D con Three.js.
- **Guardar Galería (Tecla J)**: Sistema de persistencia en servidor.
- **Importar/Exportar ZIP**: Crea copias de seguridad completas de tu galería incluyendo imágenes.
- **Notificaciones (Toasts)**: Feedback visual no intrusivo.
- **Editor en tiempo real (Tecla H)**: Gestiona tus obras fácilmente.

## Instalación Local

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Inicia el servidor:
   ```bash
   npm start
   ```
3. Abre `http://localhost:8080` en tu navegador.

## Despliegue en Vercel

### ⚠️ Nota Importante sobre la Persistencia
Este proyecto utiliza el sistema de archivos local (`data/`) para guardar configuraciones e imágenes. 
**Vercel no soporta almacenamiento persistente en disco**. 

Para un despliegue funcional en producción:
1. Se recomienda usar un servicio como **Supabase** o **Firebase** para la base de datos (JSON).
2. Usar **AWS S3** o **Cloudinary** para el almacenamiento de imágenes.
3. Desplegar el backend en un servicio con disco persistente como **Railway**, **Render** o **DigitalOcean**.
