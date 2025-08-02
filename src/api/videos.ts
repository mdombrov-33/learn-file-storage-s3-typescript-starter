import { rm } from "fs/promises";
import path from "path";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { respondWithJSON } from "./json";
import { uploadVideoToS3 } from "../s3";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File exceeds size limit (1GB)");
  }
  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type, only MP4 is allowed");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);
  const aspectRatio = await getVideoAspectRatio(tempFilePath);

  let key = `${aspectRatio}/${videoId}.mp4`;
  await uploadVideoToS3(cfg, key, tempFilePath, "video/mp4");

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  await Promise.all([rm(tempFilePath, { force: true })]);

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(
  filepath: string
): Promise<"landscape" | "portrait" | "other"> {
  const TOLERANCE = 0.05;

  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filepath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const exited = await proc.exited;

  if (exited !== 0) {
    throw new Error(`ffprobe failed with exit code ${exited}: ${stderr}`);
  }

  let width: number, height: number;
  try {
    const json = JSON.parse(stdout);
    width = json.streams?.[0]?.width;
    height = json.streams?.[0]?.height;
    if (!width || !height)
      throw new Error("Width or height not found in ffprobe output");
  } catch (e) {
    console.error("Error parsing ffprobe output:", e);
    throw e;
  }

  const ratio = width / height;

  if (Math.abs(ratio - 16 / 9) < TOLERANCE) {
    return "landscape";
  } else if (Math.abs(ratio - 9 / 16) < TOLERANCE) {
    return "portrait";
  } else {
    return "other";
  }
}

async function processVideoForFastStart(
  inputFilePath: string
): Promise<string> {
  const outputFilePath = inputFilePath + ".processed";

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stderr = await new Response(proc.stderr).text();
  const exited = await proc.exited;

  if (exited !== 0) {
    throw new Error(`ffmpeg failed with exit code ${exited}: ${stderr}`);
  }

  return outputFilePath;
}
