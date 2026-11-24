import { useLayoutEffect, useMemo } from "react";
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Typography } from "antd";
import { Database } from "lucide-react";
import type { DatabaseEngine } from "@db-studio/shared";
import { initialConnectionValues } from "./connection-form-values";

export interface ConnectionSummary {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  endpoint?: string;
  hasUri: boolean;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  path?: string;
  hasPassword: boolean;
  ssh?: {
    host: string;
    port: number;
    username: string;
    authentication: "password" | "privateKey";
    hostFingerprint: string;
    hasCredentials: boolean;
    hasPassphrase: boolean;
  };
}

export interface ConnectionValues {
  id?: string;
  name: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  uri?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  path?: string;
  ssh?: {
    enabled: boolean;
    host?: string;
    port?: number;
    username?: string;
    authentication?: "password" | "privateKey";
    hostFingerprint?: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
}

interface ConnectionFormModalProps {
  open: boolean;
  editingConnection?: ConnectionSummary;
  error?: string;
  desktopEngines: readonly DatabaseEngine[];
  engineLabels: Partial<Record<DatabaseEngine, string>>;
  defaultPorts: Partial<Record<DatabaseEngine, number>>;
  onCancel: () => void;
  onSave: (values: ConnectionValues) => void;
}

